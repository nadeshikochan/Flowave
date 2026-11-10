// Independent implementation of the on-wire facts documented in the Bluetooth
// report. Only documented wear state and auto-pause preference are queried. Device settings,
// pairing, firmware and media playback are never changed.
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Threading;

namespace FlowaveWear {
    public sealed class WearEvent {
        public string type = "wear-state", id, status;
        public bool? worn;
    }

    // Huawei's RFCOMM notifications: 5A, BE16 length, 00, service/command,
    // bounded TLVs, CRC16/XMODEM. 2B03 uses 08/09; 2B25 uses 01/02.
    public sealed class WearFrames {
        readonly List<byte> pending = new List<byte>();
        // Legacy notifications can update one ear at a time. Unknown is kept
        // until that ear reports; a single removed ear cannot imply both out.
        bool? firstEar, secondEar;
        public bool? DetectionEnabled { get; private set; }
        public int FrameCount { get; private set; }
        public int InvalidChecksums { get; private set; }
        public string LastCommand { get; private set; }
        static ushort Checksum(byte[] bytes, int count) {
            ushort crc = 0;
            for (int i = 0; i < count; i++) {
                crc ^= (ushort)(bytes[i] << 8);
                for (int bit = 0; bit < 8; bit++)
                    crc = (ushort)((crc << 1) ^ ((crc & 0x8000) != 0 ? 0x1021 : 0));
            }
            return crc;
        }
        public static byte[] ReadWearRequest() {
            byte[] bytes = { 0x5A, 0x00, 0x03, 0x00, 0x2B, 0x25, 0x00, 0x00 };
            ushort crc = Checksum(bytes, 6);
            bytes[6] = (byte)(crc >> 8); bytes[7] = (byte)crc;
            return bytes;
        }
        public bool?[] Feed(byte[] bytes, int count) {
            if (count < 0 || count > bytes.Length) throw new ArgumentOutOfRangeException("count");
            if (pending.Count + count > 8192) pending.Clear();
            for (int i = 0; i < count; i++) pending.Add(bytes[i]);
            var states = new List<bool?>();
            while (pending.Count >= 4) {
                int length = (pending[1] << 8) | pending[2];
                if (pending[0] != 0x5A || pending[3] != 0 || length < 3 || length > 1024) {
                    pending.RemoveAt(0); continue;
                }
                int size = length + 5;
                if (pending.Count < size) break;
                byte[] frame = pending.GetRange(0, size).ToArray();
                if (Checksum(frame, size - 2) != (ushort)((frame[size - 2] << 8) | frame[size - 1])) {
                    InvalidChecksums++;
                    pending.RemoveAt(0); continue;
                }
                pending.RemoveRange(0, size);
                FrameCount++;
                LastCommand = frame[4].ToString("X2") + frame[5].ToString("X2");
                bool isLegacyWear = frame[4] == 0x2B && frame[5] == 0x03;
                bool isModernWear = frame[4] == 0x2B && frame[5] == 0x25;
                bool isWear = isLegacyWear || isModernWear;
                bool isSetting = frame[4] == 0x2B && frame[5] == 0x11;
                if (!isWear && !isSetting) continue;
                int at = 6, end = size - 2;
                bool valid = true, found = false;
                bool? state = null;
                bool? nextFirst = firstEar, nextSecond = secondEar;
                var tags = new HashSet<int>();
                while (at < end) {
                    if (at + 2 > end || at + 2 + frame[at + 1] > end) { valid = false; break; }
                    int tag = frame[at], sizeOfValue = frame[at + 1];
                    if ((isLegacyWear && (tag == 8 || tag == 9)) ||
                        (isModernWear && (tag == 1 || tag == 2)) || (isSetting && tag == 1)) {
                        if (!tags.Add(tag)) { valid = false; break; }
                        bool? next = sizeOfValue == 1 && frame[at + 2] <= 1 ? (bool?)(frame[at + 2] == 1) : null;
                        if (isSetting) state = next;
                        else if (tag == 1 || tag == 8) nextFirst = next;
                        else nextSecond = next;
                        found = true;
                    }
                    at += 2 + sizeOfValue;
                }
                if (valid && found) {
                    if (isWear) {
                        firstEar = nextFirst; secondEar = nextSecond;
                        // true: at least one worn; false: both explicitly out.
                        states.Add(firstEar == true || secondEar == true ? (bool?)true
                            : firstEar == false && secondEar == false ? (bool?)false : null);
                    }
                    else DetectionEnabled = state;
                }
            }
            return states.ToArray();
        }
    }

    sealed class BluetoothEndpoint : EndPoint {
        readonly ulong address;
        public BluetoothEndpoint(ulong value) { address = value; }
        public override AddressFamily AddressFamily { get { return (AddressFamily)32; } }
        public override SocketAddress Serialize() {
            // ws2bth.h packs SOCKADDR_BTH to one byte (30 bytes in both x86/x64).
            var value = new SocketAddress(AddressFamily, 30);
            for (int i = 0; i < 8; i++) value[2 + i] = (byte)(address >> (8 * i));
            value[26] = 1; // Confirmed Pro 5 RFCOMM service channel.
            return value;
        }
        public override EndPoint Create(SocketAddress value) { return this; }
    }

    public sealed class WearWatcher : IDisposable {
        sealed class Target { public string id; public ulong address; }
        readonly object gate = new object();
        readonly ConcurrentQueue<WearEvent> queue = new ConcurrentQueue<WearEvent>();
        readonly AutoResetEvent changed = new AutoResetEvent(false);
        public readonly AutoResetEvent Signal = new AutoResetEvent(false);
        readonly Thread worker;
        Target target;
        Socket socket;
        volatile bool closed;
        readonly bool diagnostic;
        public WearWatcher() : this(false) {}
        public WearWatcher(bool diagnostics) {
            diagnostic = diagnostics;
            worker = new Thread(Run); worker.IsBackground = true; worker.Name = "Flowave headphone wear"; worker.Start();
        }
        public void SetTarget(string id, ulong address) {
            lock (gate) {
                if (closed || (target == null && address == 0) ||
                    (target != null && target.id == id && target.address == address)) return;
                target = address == 0 ? null : new Target { id = id, address = address };
                if (socket != null) socket.Close();
                changed.Set();
            }
        }
        bool Current(Target expected) { lock (gate) { return !closed && target == expected; } }
        void Publish(Target expected, string status, bool? worn) {
            lock (gate) {
                if (closed || target != expected) return;
                if (queue.Count < 64) queue.Enqueue(new WearEvent { id = expected.id, status = status, worn = worn });
                Signal.Set();
            }
        }
        public WearEvent[] Drain() {
            var events = new List<WearEvent>(); WearEvent value;
            while (queue.TryDequeue(out value)) events.Add(value);
            return events.ToArray();
        }
        void Run() {
            while (!closed) {
                Target current; lock (gate) { current = target; }
                if (current == null) { changed.WaitOne(1000); continue; }
                Socket connection = null;
                try {
                    connection = new Socket((AddressFamily)32, SocketType.Stream, (ProtocolType)3);
                    lock (gate) { if (closed || target != current) continue; socket = connection; }
                    IAsyncResult connecting = connection.BeginConnect(new BluetoothEndpoint(current.address), null, null);
                    using (var wait = connecting.AsyncWaitHandle) {
                        if (!wait.WaitOne(2000)) throw new TimeoutException();
                        connection.EndConnect(connecting);
                    }
                    connection.ReceiveTimeout = 1000;
                    connection.SendTimeout = 1000;
                    // 2B11/01 is a read of the auto-pause preference, never 2B10
                    // (the setter). Some firmware starts notifying after a read.
                    byte[][] queries = {
                        new byte[] { 0x5A, 0x00, 0x05, 0x00, 0x2B, 0x11, 0x01, 0x00, 0x77, 0x2A },
                        WearFrames.ReadWearRequest()
                    };
                    foreach (byte[] query in queries) {
                        for (int sent = 0; sent < query.Length; ) {
                            int count = connection.Send(query, sent, query.Length - sent, SocketFlags.None);
                            if (count <= 0) throw new SocketException();
                            sent += count;
                        }
                    }
                    Publish(current, "awaiting-event", null);
                    var decoder = new WearFrames(); var buffer = new byte[2048];
                    while (Current(current)) {
                        int count;
                        try { count = connection.Receive(buffer); }
                        catch (SocketException error) { if (error.SocketErrorCode == SocketError.TimedOut) continue; throw; }
                        if (count == 0) break;
                        bool? previousSetting = decoder.DetectionEnabled;
                        foreach (bool? state in decoder.Feed(buffer, count)) Publish(current, "reported", state);
                        if (previousSetting != decoder.DetectionEnabled && decoder.DetectionEnabled.HasValue)
                            Publish(current, decoder.DetectionEnabled.Value ? "detection-enabled" : "detection-disabled", null);
                        if (diagnostic) Publish(current, "rx=" + count + ",frames=" + decoder.FrameCount + ",crc=" + decoder.InvalidChecksums + ",cmd=" + decoder.LastCommand, null);
                    }
                } catch (Exception error) {
                    if (!(error is SocketException || error is ObjectDisposedException || error is TimeoutException || error is NotSupportedException || error is ArgumentException))
                        Publish(current, "listener-failed", null);
                } finally {
                    lock (gate) { if (socket == connection) socket = null; }
                    if (connection != null) connection.Close();
                }
                Publish(current, "unavailable", null);
                if (Current(current)) changed.WaitOne(10000);
            }
        }
        public void Dispose() {
            lock (gate) {
                if (closed) return;
                closed = true; target = null;
                if (socket != null) socket.Close();
                changed.Set();
            }
            worker.Join(3000);
            // A still-unwinding OS connect must not use disposed wait handles.
            if (!worker.IsAlive) { changed.Dispose(); Signal.Dispose(); }
        }
    }
}
