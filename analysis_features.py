"""Independent NumPy/SciPy Slaney filterbank frontend. No Essentia runtime.

Parameters follow the published MusiCNN input recipe: 16kHz, symmetric Hann
512, hop256, 96 Slaney bands with unit-area triangles, log10(1+10000*power).
"""
import numpy as np
from scipy.signal import resample_poly

def mel_features(wave24):
    wave=resample_poly(wave24,2,3).astype(np.float32)
    # Slaney's piecewise linear/logarithmic perceptual frequency scale.
    def to_mel(hz):
        hz=np.asarray(hz,dtype=float)
        return np.where(hz<1000,hz/(200/3),15+np.log(np.maximum(hz,1)/1000)/(np.log(6.4)/27))
    def to_hz(mel):
        return np.where(mel<15,mel*(200/3),1000*np.exp((mel-15)*(np.log(6.4)/27)))
    edges=to_hz(np.linspace(0,float(to_mel(8000)),98))
    freqs=np.arange(257)*16000/512
    filters=np.maximum(0,np.minimum((freqs[None,:]-edges[:-2,None])/(edges[1:-1]-edges[:-2])[:,None],(edges[2:,None]-freqs[None,:])/(edges[2:]-edges[1:-1])[:,None]))
    filters*= (2/(edges[2:]-edges[:-2]))[:,None]
    count=max(0,1+int(np.ceil((len(wave)-256)/256)))
    frames=np.lib.stride_tricks.sliding_window_view(np.pad(wave,(256,256)),512)[::256][:count]
    power=np.abs(np.fft.rfft(frames*np.hanning(512),axis=1))**2
    return np.log10(1+10000*(power@filters.T)).astype(np.float32)

def patches(wave):
    mel=mel_features(wave)
    return np.stack([mel[i:i+128] for i in range(0,len(mel)-127,62)])
