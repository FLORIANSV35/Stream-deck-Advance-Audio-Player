//! Native CoreAudio device enumeration, macOS only.
//!
//! cpal's macOS backend has a real bug (confirmed by reading cpal 0.15.3's source): both
//! `Device::supported_output_configs()` and `Device::default_output_config()` internally call
//! a shared helper with `input: true` hardcoded, which enables input I/O on a temporary
//! AudioUnit even when querying *output* config. That fails outright for any output-only
//! device (no input channels at all) — exactly the case for a Mac's built-in speakers or a
//! monitor's DisplayPort audio, so `cpal::Host::output_devices()` silently drops them, and even
//! explicitly selecting one by name would fail to build a stream config for it. Device
//! *creation* (`build_output_stream_raw`) is unaffected — it correctly passes `input: false` —
//! so once we have a channel count and sample rate for a device from CoreAudio directly, opening
//! a stream on it works fine.
//!
//! This module bypasses the buggy cpal calls entirely: it enumerates devices and reads their
//! output channel count / nominal sample rate straight from the CoreAudio HAL. `find_device()`
//! in voice.rs still needs an actual `cpal::Device` to hand to `build_output_stream`, which it
//! gets from `cpal::Host::devices()` (the *unfiltered* enumeration, not `output_devices()` — this
//! one isn't affected by the bug) at the same positional index as the matching native entry,
//! since both ultimately enumerate `kAudioHardwarePropertyDevices` in the same HAL-defined order.

use std::mem;
use std::os::raw::c_char;
use std::ptr;

use coreaudio_sys::{
    kAudioDevicePropertyNominalSampleRate, kAudioDevicePropertyScopeOutput,
    kAudioDevicePropertyStreamConfiguration, kAudioHardwarePropertyDevices,
    kAudioObjectPropertyElementMain, kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal,
    kAudioObjectSystemObject, kCFStringEncodingUTF8, AudioBufferList, AudioDeviceID,
    AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize, AudioObjectID,
    AudioObjectPropertyAddress, CFRelease, CFStringGetCString, CFStringGetLength,
    CFStringGetMaximumSizeForEncoding, CFStringRef,
};

fn addr(selector: u32, scope: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress { mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain }
}

fn string_prop(obj: AudioObjectID, selector: u32) -> Option<String> {
    unsafe {
        let a = addr(selector, kAudioObjectPropertyScopeGlobal);
        let mut s: CFStringRef = ptr::null();
        let mut size = mem::size_of::<CFStringRef>() as u32;
        if AudioObjectGetPropertyData(obj, &a, 0, ptr::null(), &mut size, &mut s as *mut _ as *mut _) != 0
            || s.is_null()
        {
            return None;
        }
        let max_size = CFStringGetMaximumSizeForEncoding(CFStringGetLength(s), kCFStringEncodingUTF8) + 1;
        let mut buf = vec![0 as c_char; max_size as usize];
        let ok = CFStringGetCString(s, buf.as_mut_ptr(), buf.len() as _, kCFStringEncodingUTF8);
        CFRelease(s as _);
        if ok == 0 {
            return None;
        }
        Some(std::ffi::CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned())
    }
}

fn output_channels(dev: AudioDeviceID) -> usize {
    unsafe {
        let a = addr(kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyScopeOutput);
        let mut size: u32 = 0;
        if AudioObjectGetPropertyDataSize(dev, &a, 0, ptr::null(), &mut size) != 0 || size == 0 {
            return 0;
        }
        let mut buf = vec![0u8; size as usize];
        if AudioObjectGetPropertyData(dev, &a, 0, ptr::null(), &mut size, buf.as_mut_ptr() as *mut _) != 0 {
            return 0;
        }
        let list = buf.as_ptr() as *const AudioBufferList;
        let n_buffers = (*list).mNumberBuffers as usize;
        let buffers = std::slice::from_raw_parts((*list).mBuffers.as_ptr(), n_buffers);
        buffers.iter().map(|b| b.mNumberChannels as usize).sum()
    }
}

fn nominal_sample_rate(dev: AudioDeviceID) -> f64 {
    unsafe {
        let a = addr(kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal);
        let mut rate: f64 = 0.0;
        let mut size = mem::size_of::<f64>() as u32;
        if AudioObjectGetPropertyData(dev, &a, 0, ptr::null(), &mut size, &mut rate as *mut _ as *mut _) != 0 {
            return 48000.0;
        }
        if rate > 0.0 {
            rate
        } else {
            48000.0
        }
    }
}

/// All the raw device IDs known to CoreAudio, in HAL order — the same order cpal's own
/// (unfiltered) `Host::devices()` iterates on macOS, since both ultimately query the same
/// `kAudioHardwarePropertyDevices` property.
fn all_device_ids() -> Vec<AudioDeviceID> {
    unsafe {
        let a = addr(kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal);
        let mut size: u32 = 0;
        if AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &a, 0, ptr::null(), &mut size) != 0 {
            return Vec::new();
        }
        let count = size as usize / mem::size_of::<AudioDeviceID>();
        let mut ids = vec![0 as AudioDeviceID; count];
        if AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, ptr::null(), &mut size, ids.as_mut_ptr() as *mut _) != 0 {
            return Vec::new();
        }
        ids
    }
}

pub struct NativeDev {
    pub uid: String,
    pub name: String,
    pub channels: usize,
    pub sample_rate: f64,
    /// index into the raw, unfiltered device list — also cpal's own `Host::devices()` order
    pub raw_index: usize,
}

/// Output-capable devices, straight from CoreAudio (bypasses cpal's buggy filtering). The
/// identifier is the name (suffixed " (2)"… when duplicated), matching the scheme the rest of
/// the engine already expects.
pub fn output_devices() -> Vec<NativeDev> {
    let mut result = Vec::new();
    for (raw_index, &id) in all_device_ids().iter().enumerate() {
        let channels = output_channels(id);
        if channels == 0 {
            continue;
        }
        let Some(name) = string_prop(id, kAudioObjectPropertyName) else { continue };
        let mut uid = name.clone();
        let mut n = 2;
        while result.iter().any(|d: &NativeDev| d.uid == uid) {
            uid = format!("{name} ({n})");
            n += 1;
        }
        result.push(NativeDev { uid, name, channels, sample_rate: nominal_sample_rate(id), raw_index });
    }
    result
}

/// Channel count and sample rate of the system's current default output device — used for the
/// "default" pseudo-uid, which isn't in `output_devices()`'s list (it's a magic string, not an
/// enumerated device) but would hit the same cpal bug if we asked cpal for its config.
pub fn default_device_config() -> Option<(usize, f64)> {
    unsafe {
        let a = addr(coreaudio_sys::kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal);
        let mut dev: AudioDeviceID = 0;
        let mut size = mem::size_of::<AudioDeviceID>() as u32;
        if AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, ptr::null(), &mut size, &mut dev as *mut _ as *mut _) != 0 {
            return None;
        }
        let channels = output_channels(dev);
        if channels == 0 {
            return None;
        }
        Some((channels, nominal_sample_rate(dev)))
    }
}
