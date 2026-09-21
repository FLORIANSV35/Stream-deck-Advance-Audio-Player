// saap-engine: audio engine for the SAAP Stream Deck plugin.
// Protocol: one JSON command per line on stdin, one JSON event per line on stdout.
// Each playback = a dedicated AVAudioEngine, bound to one device and to specific output channels.

#import <AVFoundation/AVFoundation.h>
#import <CoreAudio/CoreAudio.h>
#import <AudioToolbox/AudioToolbox.h>
#include <mach/mach_time.h>

#pragma mark - JSON output

static NSLock *outLock;
static void emit(NSDictionary *obj) {
    NSData *d = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
    if (!d) return;
    [outLock lock];
    NSMutableData *line = [d mutableCopy];
    [line appendBytes:"\n" length:1];
    [[NSFileHandle fileHandleWithStandardOutput] writeData:line];
    [outLock unlock];
}

#pragma mark - Devices

static AudioObjectPropertyAddress addr(AudioObjectPropertySelector sel, AudioObjectPropertyScope scope) {
    return (AudioObjectPropertyAddress){ sel, scope, kAudioObjectPropertyElementMain };
}

static NSString *stringProp(AudioObjectID obj, AudioObjectPropertySelector sel) {
    AudioObjectPropertyAddress a = addr(sel, kAudioObjectPropertyScopeGlobal);
    CFStringRef s = NULL;
    UInt32 size = sizeof(s);
    if (AudioObjectGetPropertyData(obj, &a, 0, NULL, &size, &s) != noErr || !s) return nil;
    return (__bridge_transfer NSString *)s;
}

static int outputChannelCount(AudioDeviceID dev) {
    AudioObjectPropertyAddress a = addr(kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyScopeOutput);
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(dev, &a, 0, NULL, &size) != noErr || size == 0) return 0;
    AudioBufferList *list = malloc(size);
    int n = 0;
    if (AudioObjectGetPropertyData(dev, &a, 0, NULL, &size, list) == noErr)
        for (UInt32 i = 0; i < list->mNumberBuffers; i++) n += list->mBuffers[i].mNumberChannels;
    free(list);
    return n;
}

// [{id, uid, name, channels}] of the devices that have at least one output
static NSArray<NSDictionary *> *outputDevices(void) {
    AudioObjectPropertyAddress a = addr(kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal);
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &a, 0, NULL, &size) != noErr) return @[];
    AudioDeviceID *ids = malloc(size);
    NSMutableArray *res = [NSMutableArray array];
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, &size, ids) == noErr) {
        for (UInt32 i = 0; i < size / sizeof(AudioDeviceID); i++) {
            int ch = outputChannelCount(ids[i]);
            NSString *uid = stringProp(ids[i], kAudioDevicePropertyDeviceUID);
            if (ch <= 0 || !uid) continue;
            [res addObject:@{ @"id": @(ids[i]), @"uid": uid,
                              @"name": stringProp(ids[i], kAudioObjectPropertyName) ?: uid,
                              @"channels": @(ch) }];
        }
    }
    free(ids);
    return res;
}

static int defaultDeviceChannels(void) {
    AudioObjectPropertyAddress a = addr(kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal);
    AudioDeviceID dev = 0;
    UInt32 size = sizeof(dev);
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, &size, &dev) != noErr) return 2;
    return MAX(1, outputChannelCount(dev));
}

#pragma mark - Instance

@interface SAInstance : NSObject
@property (nonatomic, copy) NSString *ident;
@property (nonatomic, copy) void (^onEnded)(SAInstance *, NSString *);
@property (nonatomic, readonly) BOOL paused;
@property (nonatomic, readonly) double duration;
- (instancetype)initWithCommand:(NSDictionary *)c error:(NSString **)err;
- (double)position;
- (void)setVolume:(float)v;
- (void)pause;
- (void)resume;
- (void)seekTo:(double)seconds;
- (void)seekTo:(double)seconds atHost:(uint64_t)host resume:(BOOL)resume;
- (void)playAtHostTime:(uint64_t)host;
- (double)latency;
- (NSDictionary *)syncInfo;
- (void)stopWithFade:(double)seconds;
- (void)cut;
- (void)tick;
@end

@implementation SAInstance {
    NSURL *_url;
    AVAudioEngine *_engine;
    AVAudioPlayerNode *_player;
    double _rate;
    AVAudioFramePosition _start, _end;
    BOOL _loop, _closed, _fadingOut;
    double _autoFadeOut, _lastPos;
    int _pending;
    int _gen;             // changes on every seek: ignores the ends of stale segments
    double _baseOffset;   // position (within the trim) at which the current scheduling started
    float _gain, _curGain, _fade;
    // fade ramp
    BOOL _hasRamp, _rampStop;
    float _rampFrom, _rampTo;
    double _rampT0, _rampDur;
}

static double nowSec(void) { return [NSProcessInfo processInfo].systemUptime; }

static double num(NSDictionary *c, NSString *k, double d) {
    id v = c[k];
    return [v isKindOfClass:[NSNumber class]] ? [v doubleValue] : d;
}

- (instancetype)initWithCommand:(NSDictionary *)c error:(NSString **)err {
    if (!(self = [super init])) return nil;
    _ident = c[@"id"];
    NSString *path = c[@"file"];
    _url = [NSURL fileURLWithPath:path];
    NSError *e = nil;
    AVAudioFile *file = [[AVAudioFile alloc] initForReading:_url error:&e];
    if (!file) { *err = [NSString stringWithFormat:@"Unreadable file: %@", path]; return nil; }

    _rate = file.processingFormat.sampleRate;
    AVAudioFramePosition total = file.length;
    _start = MIN(MAX(0, (AVAudioFramePosition)(num(c, @"trimIn", 0) * _rate)), total);
    double tout = num(c, @"trimOut", 0);
    _end = tout > 0 ? MIN(total, (AVAudioFramePosition)(tout * _rate)) : total;
    if (_end <= _start) { *err = @"Invalid trim points"; return nil; }
    _duration = (double)(_end - _start) / _rate;
    _loop = [c[@"loop"] boolValue];
    _autoFadeOut = num(c, @"fadeOut", 0);
    _gain = _curGain = MAX(0, MIN(1, (float)num(c, @"volume", 1)));
    _fade = 1;

    _engine = [AVAudioEngine new];
    _player = [AVAudioPlayerNode new];
    AVAudioOutputNode *out = _engine.outputNode;

    // Output device
    NSString *uid = c[@"device"] ?: @"default";
    int devChannels;
    if (![uid isEqualToString:@"default"]) {
        NSDictionary *found = nil;
        for (NSDictionary *d in outputDevices()) if ([d[@"uid"] isEqualToString:uid]) { found = d; break; }
        if (!found) { *err = [NSString stringWithFormat:@"Device not found: %@", uid]; return nil; }
        if (![out.AUAudioUnit setDeviceID:[found[@"id"] unsignedIntValue] error:&e]) {
            *err = [NSString stringWithFormat:@"Cannot use %@", found[@"name"]]; return nil;
        }
        devChannels = [found[@"channels"] intValue];
    } else {
        devChannels = defaultDeviceChannels();
    }

    [_engine attachNode:_player];
    AVAudioMixerNode *mixer = _engine.mainMixerNode;
    double devRate = [out outputFormatForBus:0].sampleRate;
    [_engine connect:_player to:mixer format:file.processingFormat];

    // Routing to specific channels: the mixer outputs stereo, and the output unit's channel map
    // places the 2 channels (or just 1 in mono) on the chosen channels of the device.
    int channel = (int)num(c, @"channel", 0);
    BOOL mono = [c[@"mono"] boolValue];
    if (devChannels > 2 || channel != 0 || mono) {
        AVAudioFormat *stereo = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:devRate channels:2];
        [_engine connect:mixer to:out format:stereo];
        int n = MAX(devChannels, channel + (mono ? 1 : 2));
        NSMutableArray *map = [NSMutableArray arrayWithCapacity:n];
        for (int i = 0; i < n; i++) [map addObject:@(-1)];
        map[channel] = @0;
        if (!mono) map[channel + 1] = @1;
        out.AUAudioUnit.channelMap = map;
    }

    double fadeIn = num(c, @"fadeIn", 0);
    if (fadeIn > 0) { _fade = 0; [self startRampTo:1 dur:fadeIn stop:NO]; }
    _player.volume = _curGain * _fade;

    for (int i = 0; i < (_loop ? 2 : 1); i++) if (![self scheduleFrom:0]) { *err = @"Cannot read the file"; return nil; }
    if (![_engine startAndReturnError:&e]) {
        *err = [NSString stringWithFormat:@"Cannot start audio: %@", e.localizedDescription]; return nil;
    }
    return self;
}

// Schedules playback of the trim starting at `offset` seconds (0 = start of the trim).
- (BOOL)scheduleFrom:(double)offset {
    NSError *e = nil;
    AVAudioFile *f = [[AVAudioFile alloc] initForReading:_url error:&e];
    if (!f) return NO;
    AVAudioFramePosition from = _start + (AVAudioFramePosition)(offset * _rate);
    if (from >= _end) from = _start;
    _pending++;
    int gen = _gen;
    __weak SAInstance *ws = self;
    [_player scheduleSegment:f startingFrame:from frameCount:(AVAudioFrameCount)(_end - from) atTime:nil
      completionCallbackType:AVAudioPlayerNodeCompletionDataPlayedBack
           completionHandler:^(AVAudioPlayerNodeCompletionCallbackType t) {
        dispatch_async(dispatch_get_main_queue(), ^{ [ws segmentDone:gen]; });
    }];
    return YES;
}

- (void)segmentDone:(int)gen {
    if (_closed || gen != _gen) return;
    _pending--;
    if (_loop) [self scheduleFrom:0];
    else if (_pending <= 0) [self finish:@"finished"];
}

- (double)position {
    AVAudioTime *nt = _player.lastRenderTime;
    AVAudioTime *pt = nt ? [_player playerTimeForNodeTime:nt] : nil;
    if (!pt || pt.sampleTime < 0) return _lastPos;
    double p = _baseOffset + (double)pt.sampleTime / pt.sampleRate;
    if (_loop) p = fmod(p, _duration);
    _lastPos = MIN(p, _duration);
    return _lastPos;
}

static double hostDelay(uint64_t host) {
    uint64_t now = mach_absolute_time();
    return host > now ? [AVAudioTime secondsForHostTime:host - now] : 0;
}

// Starts playback at an exact instant of the system clock (0 = right now).
// This is what aligns several tracks: every player starts at exactly that instant, sample-accurately.
- (void)playAtHostTime:(uint64_t)host {
    if (host) [_player playAtTime:[AVAudioTime timeWithHostTime:host]];
    else [_player play];
    // the fade in must start with the sound, not with the preparation
    if (_hasRamp && !_rampStop) _rampT0 = nowSec() + hostDelay(host);
}

- (double)latency { return _engine.outputNode.presentationLatency; }

// Instant (system clock, in seconds) at which the first sample of the playback was rendered, and output latency.
// Used to measure the offset between two playbacks: difference of "start" = offset, "emerges" accounts for latency.
- (NSDictionary *)syncInfo {
    AVAudioTime *nt = _player.lastRenderTime;
    AVAudioTime *pt = nt ? [_player playerTimeForNodeTime:nt] : nil;
    if (!pt || !nt.hostTimeValid) return @{ @"id": _ident };
    double start = [AVAudioTime secondsForHostTime:nt.hostTime] - (double)pt.sampleTime / pt.sampleRate - _baseOffset;
    double lat = _engine.outputNode.presentationLatency;
    return @{ @"id": _ident, @"start": @(start), @"latency": @(lat), @"emerges": @(start + lat) };
}

// Moves playback: the native player cannot "seek", so we stop it and reschedule from the new position.
- (void)seekTo:(double)seconds { [self seekTo:seconds atHost:0 resume:NO]; }

- (void)seekTo:(double)seconds atHost:(uint64_t)host resume:(BOOL)resume {
    if (_closed) return;
    if (_loop) { seconds = fmod(seconds, _duration); if (seconds < 0) seconds += _duration; }
    else if (seconds >= _duration - 0.02) { [self finish:@"finished"]; return; }
    seconds = MAX(0, seconds);
    if (resume) _paused = NO;
    _gen++;
    _pending = 0;
    [_player stop];
    _baseOffset = seconds;
    _lastPos = seconds;
    [self scheduleFrom:seconds];
    if (_loop) [self scheduleFrom:0];
    [self playAtHostTime:host];
    if (_paused) [_player pause];
    // moved back before the automatic fade-out zone: cancel it
    if (_fadingOut && !_rampStop && seconds < _duration - _autoFadeOut) { _fadingOut = NO; _hasRamp = NO; _fade = 1; }
}

- (void)setVolume:(float)v { _gain = MAX(0, MIN(1, v)); }

- (void)pause {
    if (_paused) return;
    (void)[self position];
    [_player pause];
    _paused = YES;
}

- (void)resume {
    if (!_paused) return;
    [_player play];
    _paused = NO;
}

- (void)startRampTo:(float)to dur:(double)dur stop:(BOOL)stop {
    _rampFrom = _fade; _rampTo = to; _rampT0 = nowSec(); _rampDur = MAX(dur, 0.001);
    _rampStop = stop; _hasRamp = YES;
}

- (void)stopWithFade:(double)seconds {
    if (_closed) return;
    if (seconds <= 0) { [self finish:@"stopped"]; return; }
    if (_paused) [self resume];
    _fadingOut = YES;
    [self startRampTo:0 dur:seconds stop:YES];
}

- (void)cut { [self finish:@"stopped"]; }

- (void)tick {
    if (_closed) return;
    double t = nowSec();
    if (_hasRamp) {
        float p = (float)MIN(1, MAX(0, (t - _rampT0) / _rampDur));
        // sine/cosine curves: constant-power fade, no "click" at the start or the end
        _fade = _rampTo > _rampFrom
            ? _rampFrom + (_rampTo - _rampFrom) * sinf(p * M_PI_2)
            : _rampTo + (_rampFrom - _rampTo) * cosf(p * M_PI_2);
        if (p >= 1) {
            _hasRamp = NO; _fade = _rampTo;
            if (_rampStop) { [self finish:@"stopped"]; return; }
        }
    }
    if (!_loop && !_fadingOut && _autoFadeOut > 0 && !_paused) {
        double remaining = _duration - [self position];
        if (remaining <= _autoFadeOut) {
            _fadingOut = YES;
            [self startRampTo:0 dur:MAX(remaining, 0.05) stop:NO];
        }
    }
    _curGain += (_gain - _curGain) * 0.3f;
    _player.volume = _curGain * _fade;
}

- (void)finish:(NSString *)reason {
    if (_closed) return;
    _closed = YES;
    [_player stop];
    [_engine stop];
    if (_onEnded) _onEnded(self, reason);
}

@synthesize paused = _paused;
@end

#pragma mark - Forme d'onde

// Peak (max absolute value, all channels) of each slice of the file, for the waveform display.
static NSDictionary *computePeaks(NSString *path, int n, id req) {
    NSError *e = nil;
    AVAudioFile *f = [[AVAudioFile alloc] initForReading:[NSURL fileURLWithPath:path] error:&e];
    if (!f || f.length <= 0) return @{ @"evt": @"peaks", @"req": req, @"error": @"Unreadable file" };
    n = MAX(10, MIN(n, 4000));
    AVAudioFramePosition total = f.length;
    AVAudioPCMBuffer *buf = [[AVAudioPCMBuffer alloc] initWithPCMFormat:f.processingFormat frameCapacity:65536];
    float *mx = calloc(n, sizeof(float));
    AVAudioFramePosition pos = 0;
    while (pos < total) {
        if (![f readIntoBuffer:buf frameCount:65536 error:&e] || buf.frameLength == 0) break;
        for (AVAudioChannelCount ch = 0; ch < buf.format.channelCount; ch++) {
            const float *d = buf.floatChannelData[ch];
            for (AVAudioFrameCount i = 0; i < buf.frameLength; i++) {
                int idx = (int)(((pos + i) * (int64_t)n) / total);
                if (idx >= n) idx = n - 1;
                float v = fabsf(d[i]);
                if (v > mx[idx]) mx[idx] = v;
            }
        }
        pos += buf.frameLength;
    }
    NSMutableArray *peaks = [NSMutableArray arrayWithCapacity:n];
    for (int i = 0; i < n; i++) [peaks addObject:@(roundf(MIN(mx[i], 1.0f) * 1000) / 1000)];
    free(mx);
    return @{ @"evt": @"peaks", @"req": req, @"duration": @((double)total / f.processingFormat.sampleRate), @"peaks": peaks };
}

#pragma mark - Controller

static NSMutableDictionary<NSString *, SAInstance *> *instances;

// Creates the playback (engine ready, not started yet). nil + error event on failure.
static SAInstance *createInstance(NSDictionary *c) {
    NSString *ident = c[@"id"];
    if (![ident isKindOfClass:[NSString class]] || ![c[@"file"] isKindOfClass:[NSString class]]) return nil;
    [instances[ident] cut];
    NSString *err = nil;
    SAInstance *inst = [[SAInstance alloc] initWithCommand:c error:&err];
    if (!inst) { emit(@{ @"evt": @"ended", @"id": ident, @"reason": @"error", @"message": err ?: @"Error" }); return nil; }
    inst.onEnded = ^(SAInstance *i, NSString *reason) {
        if (instances[i.ident] == i) [instances removeObjectForKey:i.ident];
        emit(@{ @"evt": @"ended", @"id": i.ident, @"reason": reason });
    };
    instances[ident] = inst;
    return inst;
}

static void startInstance(NSDictionary *c) {
    SAInstance *inst = createInstance(c);
    if (!inst) return;
    [inst playAtHostTime:0];
    emit(@{ @"evt": @"started", @"id": inst.ident, @"duration": @(inst.duration) });
}

// Common start instant, compensating each output's latency: the sound *comes out* at the same time.
static uint64_t syncBase(double lead) { return mach_absolute_time() + [AVAudioTime hostTimeForSeconds:lead]; }
static uint64_t syncHost(uint64_t base, NSArray<SAInstance *> *all, SAInstance *i) {
    double maxLat = 0;
    for (SAInstance *o in all) maxLat = MAX(maxLat, [o latency]);
    return base + [AVAudioTime hostTimeForSeconds:MAX(0, maxLat - [i latency])];
}

// Starts several playbacks at the same instant.
static void startBatch(NSArray *items) {
    NSMutableArray<SAInstance *> *created = [NSMutableArray array];
    for (NSDictionary *c in items) {
        SAInstance *inst = [c isKindOfClass:[NSDictionary class]] ? createInstance(c) : nil;
        if (inst) [created addObject:inst];
    }
    uint64_t base = syncBase(0.2);
    for (SAInstance *i in created) [i playAtHostTime:syncHost(base, created, i)];
    for (SAInstance *i in created) emit(@{ @"evt": @"started", @"id": i.ident, @"duration": @(i.duration) });
}

static NSArray<SAInstance *> *instancesFor(NSDictionary *c) {
    NSMutableArray *list = [NSMutableArray array];
    for (NSString *ident in c[@"ids"] ?: @[]) {
        SAInstance *i = [ident isKindOfClass:[NSString class]] ? instances[ident] : nil;
        if (i) [list addObject:i];
    }
    return list;
}

// Moves (or resumes after a pause) several playbacks at the same instant.
// All restart from the position of the first one: this also realigns tracks that may have drifted.
static void seekMany(NSArray<SAInstance *> *list, NSDictionary *c, BOOL resume) {
    if (list.count == 0) return;
    double target = c[@"to"] ? num(c, @"to", 0) : [list[0] position] + num(c, @"delta", 0);
    uint64_t base = syncBase(0.15);
    for (SAInstance *i in list) [i seekTo:target atHost:syncHost(base, list, i) resume:resume];
}

static void handle(NSString *line) {
    NSDictionary *c = [NSJSONSerialization JSONObjectWithData:[line dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    if (![c isKindOfClass:[NSDictionary class]]) return;
    NSString *cmd = c[@"cmd"], *ident = c[@"id"];
    SAInstance *inst = ident ? instances[ident] : nil;
    double fade = num(c, @"fade", 0);
    if ([cmd isEqualToString:@"devices"]) {
        NSMutableArray *list = [NSMutableArray array];
        for (NSDictionary *d in outputDevices()) [list addObject:@{ @"uid": d[@"uid"], @"name": d[@"name"], @"channels": d[@"channels"] }];
        emit(@{ @"evt": @"devices", @"devices": list });
    }
    else if ([cmd isEqualToString:@"play"]) startInstance(c);
    else if ([cmd isEqualToString:@"playBatch"] && [c[@"items"] isKindOfClass:[NSArray class]]) startBatch(c[@"items"]);
    else if ([cmd isEqualToString:@"stop"]) [inst stopWithFade:fade];
    else if ([cmd isEqualToString:@"cut"]) [inst cut];
    else if ([cmd isEqualToString:@"pause"]) { if (c[@"ids"]) for (SAInstance *i in instancesFor(c)) [i pause]; else [inst pause]; }
    else if ([cmd isEqualToString:@"seek"]) {
        if (c[@"ids"]) seekMany(instancesFor(c), c, NO);
        else if (c[@"to"]) [inst seekTo:num(c, @"to", 0)];
        else [inst seekTo:[inst position] + num(c, @"delta", 0)];
    }
    else if ([cmd isEqualToString:@"resume"]) { if (c[@"ids"]) seekMany(instancesFor(c), @{ @"delta": @0 }, YES); else [inst resume]; }
    else if ([cmd isEqualToString:@"volume"]) [inst setVolume:(float)num(c, @"value", 1)];
    else if ([cmd isEqualToString:@"stopAll"]) for (SAInstance *i in instances.allValues) [i stopWithFade:fade];
    else if ([cmd isEqualToString:@"cutAll"]) for (SAInstance *i in instances.allValues) [i cut];
    else if ([cmd isEqualToString:@"peaks"] && c[@"req"] && [c[@"file"] isKindOfClass:[NSString class]]) {
        NSString *file = c[@"file"]; id req = c[@"req"]; int n = (int)num(c, @"n", 600);
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{ emit(computePeaks(file, n, req)); });
    }
    else if ([cmd isEqualToString:@"syncInfo"]) {
        NSMutableArray *items = [NSMutableArray array];
        for (SAInstance *i in instances.allValues) [items addObject:[i syncInfo]];
        emit(@{ @"evt": @"syncInfo", @"items": items });
    }
    else if ([cmd isEqualToString:@"quit"]) exit(0);
}

int main(void) {
    @autoreleasepool {
        outLock = [NSLock new];
        instances = [NSMutableDictionary dictionary];

        NSThread *reader = [[NSThread alloc] initWithBlock:^{
            char *buf = NULL; size_t cap = 0; ssize_t n;
            while ((n = getline(&buf, &cap, stdin)) > 0) {
                NSString *line = [[NSString alloc] initWithBytes:buf length:n encoding:NSUTF8StringEncoding];
                if (line) dispatch_async(dispatch_get_main_queue(), ^{ handle(line); });
            }
            exit(0); // stdin closed: the plugin is gone
        }];
        [reader start];

        __block int ticks = 0;
        dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
        dispatch_source_set_timer(timer, DISPATCH_TIME_NOW, 20 * NSEC_PER_MSEC, 2 * NSEC_PER_MSEC);
        dispatch_source_set_event_handler(timer, ^{
            ticks++;
            for (SAInstance *i in instances.allValues) [i tick];
            if (ticks % 5 == 0)
                for (SAInstance *i in instances.allValues)
                    emit(@{ @"evt": @"state", @"id": i.ident, @"state": i.paused ? @"paused" : @"playing",
                            @"pos": @([i position]), @"dur": @(i.duration) });
        });
        dispatch_resume(timer);
        emit(@{ @"evt": @"ready" });
        dispatch_main();
    }
}
