# Static native protocol checks only. No COM, sockets, player or devices started.
$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot '../tools/audio-output/wear-state.cs'
$source = [IO.File]::ReadAllText((Resolve-Path $sourcePath))
$checks = @'
namespace FlowaveWear {
    public static class WearChecks {
        static byte[] Hex(string text) {
            var bytes = new byte[text.Length / 2];
            for (int i = 0; i < bytes.Length; i++) bytes[i] = System.Convert.ToByte(text.Substring(i * 2, 2), 16);
            return bytes;
        }
        static void Assert(bool value, string message) { if (!value) throw new System.Exception(message); }
        static bool?[] Decode(string text) { byte[] bytes = Hex(text); return new WearFrames().Feed(bytes, bytes.Length); }
        public static void Run() {
            byte[] outgoing = WearFrames.ReadWearRequest();
            Assert(outgoing.Length == 8 && outgoing[4] == 0x2B && outgoing[5] == 0x25, "Only wear read requested");
            Assert(Decode("5a0006002b03080100a79d")[0] == false, "Legacy removal");
            Assert(Decode("5a0009002b25010100020101ca4b")[0] == false, "Either ear removed must pause");
            Assert(Decode("5a0009002b25010101020101bcff")[0] == true, "Both worn");
            Assert(Decode("5a0006002b250101020999")[0] == null, "Unknown enum is not removal");
            Assert(Decode("5a0006002b25010500e51f").Length == 0, "Truncated TLV rejected");
            Assert(Decode("5a0009002b25010101010100f58e").Length == 0, "Duplicate ear field rejected");
            Assert(Decode("5a0007002b2a010200001531").Length == 0, "ANC must not be wear");
            byte[] setting = Hex("5a0006002b11010101dfe2"); var preference = new WearFrames();
            Assert(preference.Feed(setting, setting.Length).Length == 0 && preference.DetectionEnabled == true, "Preference is not live wear");
            byte[] worn = Hex("5a0009002b25010101020101bcff"); var fragmented = new WearFrames();
            byte[] prefix = new byte[] { worn[0], worn[1], worn[2] };
            byte[] suffix = new byte[worn.Length - 3]; System.Array.Copy(worn, 3, suffix, 0, suffix.Length);
            Assert(fragmented.Feed(prefix, prefix.Length).Length == 0, "Partial frame waits");
            Assert(fragmented.Feed(suffix, suffix.Length)[0] == true, "Partial frame completes");
            byte[] damaged = (byte[])worn.Clone(); damaged[damaged.Length - 1] ^= 1;
            byte[] joined = new byte[damaged.Length + worn.Length];
            System.Array.Copy(damaged, joined, damaged.Length); System.Array.Copy(worn, 0, joined, damaged.Length, worn.Length);
            bool?[] recovered = new WearFrames().Feed(joined, joined.Length);
            Assert(recovered.Length == 1 && recovered[0] == true, "Bad checksum rejected and next frame recovered");
        }
    }
}
'@
Add-Type -TypeDefinition ($source + [Environment]::NewLine + $checks)
[FlowaveWear.WearChecks]::Run()
'Native wear parser checks passed; no device access.'
