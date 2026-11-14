// Load the actual packaged dependencies through Node's standard resolver.
const path = require('node:path');
const {createRequire} = require('node:module');
const {pathToFileURL} = require('node:url');
const temporary = path.resolve(process.argv[2]);

(async () => {
  const load = createRequire(path.join(temporary, 'package.json'));
  const sharp = load('sharp');
  const image = await sharp(Buffer.from([32, 64, 96]), {raw:{width:1, height:1, channels:3}}).png().toBuffer();
  if ((await sharp(image).metadata()).width !== 1) throw Error('Packaged image processing failed');
  const metadata = await import(pathToFileURL(load.resolve('music-metadata')).href);
  const audio = Buffer.alloc(44 + 88200);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(44100, 24); audio.writeUInt32LE(88200, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  const parsed = await metadata.parseBuffer(audio, {mimeType:'audio/wav'});
  if (parsed.format.sampleRate !== 44100) throw Error('Packaged audio metadata failed');
  if (typeof load('axios').get !== 'function') throw Error('Packaged network dependency failed');
  console.log('Packaged Sharp image processing, WAV metadata and Axios imports passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
