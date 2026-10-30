# SoundTouchJS AudioWorklet

- Source: https://github.com/cutterbl/SoundTouchJS
- npm: @soundtouchjs/audio-worklet 2.1.1
- Tarball: https://registry.npmjs.org/@soundtouchjs/audio-worklet/-/audio-worklet-2.1.1.tgz
- Verified npm integrity: sha512-itxSW62gbtDKoFo6eEr4PXzVz3oF+wCVREupFi5JiUR31tWWwCizr+2XezYD1SnkrSDfdmZvvviTtoyejYeD0Q==
- License: Mozilla Public License 2.0; see soundtouch-LICENSE.txt and https://mozilla.org/MPL/2.0/.
- Copyright: Olli Parviainen, Ryan Berdeen, Jakub Fiala, Steve “Cutter” Blades and contributors.
- The bundled DSP processor is supplied as readable source. Flowave adds a processor subclass at the end to gate scheduled startup, report the first emitted output frame for the media clock, and stop disposed processors. DSP routines are retained from the pinned upstream package.
