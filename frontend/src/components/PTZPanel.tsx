'use client';

// PTZ operator panel for the enlarged (peek / popout) live view. Composes the
// virtual joystick, an optical-zoom rocker, and a preset bar. Reuses the
// existing fire-and-forget PTZ client (ptzMove/ptzStop/ptzPrewarm) and the
// Milesight preset passthrough (get.ptz.preset list + preset goto).
//
// Scope (PR 1): joystick + zoom + recall presets. Preset SAVE/DELETE and
// auto-home are intentionally absent — they need new backend routes (PR 2).

import { useCallback, useEffect, useRef, useState } from 'react';
import { ptzMove, ptzStop, ptzPrewarm } from '@/lib/api';
import { milesightPTZGoto, type PTZPresetPanel } from '@/lib/milesight';
import { usePanel } from '@/components/milesight/shared';
import VirtualJoystick from './VirtualJoystick';

const MOVE_THROTTLE_MS = 100;   // ~10 ContinuousMove/s — smooth without flooding ONVIF

export default function PTZPanel({ cameraId }: { cameraId: string }) {
    // Warm the ONVIF client cache so the first joystick move isn't a cold start.
    useEffect(() => { ptzPrewarm(cameraId); }, [cameraId]);

    // Joystick velocity → throttled ptzMove; deadzone / release → a single ptzStop.
    const lastVel = useRef<{ pan: number; tilt: number }>({ pan: 0, tilt: 0 });
    const sentZero = useRef(true);
    const lastSentTs = useRef(0);
    const trailing = useRef<ReturnType<typeof setTimeout> | null>(null);

    const flush = useCallback(() => {
        const { pan, tilt } = lastVel.current;
        if (pan === 0 && tilt === 0) {
            if (!sentZero.current) { ptzStop(cameraId); sentZero.current = true; }
            return;
        }
        sentZero.current = false;
        ptzMove(cameraId, pan, tilt, 0);
    }, [cameraId]);

    const onJoyMove = useCallback((pan: number, tilt: number) => {
        lastVel.current = { pan, tilt };
        const since = Date.now() - lastSentTs.current;
        if (since >= MOVE_THROTTLE_MS) {
            lastSentTs.current = Date.now();
            flush();
        } else if (!trailing.current) {
            trailing.current = setTimeout(() => {
                trailing.current = null;
                lastSentTs.current = Date.now();
                flush();
            }, MOVE_THROTTLE_MS - since);
        }
    }, [flush]);

    const onJoyEnd = useCallback(() => {
        if (trailing.current) { clearTimeout(trailing.current); trailing.current = null; }
        lastVel.current = { pan: 0, tilt: 0 };
        ptzStop(cameraId);
        sentZero.current = true;
    }, [cameraId]);

    // Safety: stop motion + clear timers if the panel unmounts mid-drag.
    useEffect(() => () => {
        if (trailing.current) clearTimeout(trailing.current);
        ptzStop(cameraId);
    }, [cameraId]);

    const zoomStart = (dir: number) => ptzMove(cameraId, 0, 0, dir);
    const zoomStop = () => ptzStop(cameraId);

    return (
        <div style={{
            display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
            padding: '10px 14px', background: 'rgba(0,0,0,0.6)', borderRadius: 10,
            backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,0.1)',
        }}>
            <VirtualJoystick onMove={onJoyMove} onEnd={onJoyEnd} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>ZOOM</span>
                <button className="ptz-btn" aria-label="Zoom in"
                    onPointerDown={() => zoomStart(1)} onPointerUp={zoomStop} onPointerLeave={zoomStop} onPointerCancel={zoomStop}>+</button>
                <button className="ptz-btn" aria-label="Zoom out"
                    onPointerDown={() => zoomStart(-1)} onPointerUp={zoomStop} onPointerLeave={zoomStop} onPointerCancel={zoomStop}>−</button>
            </div>

            <PresetBar cameraId={cameraId} />
        </div>
    );
}

// Recall-only preset bar. Lists device presets via the Milesight config
// passthrough (get.ptz.preset) and recalls on click. Save/delete need backend
// (PR 2). On a non-Milesight camera the passthrough 404s → "unavailable".
function PresetBar({ cameraId }: { cameraId: string }) {
    const { data, error, loading } = usePanel<PTZPresetPanel>(cameraId, 'ptzPresets');
    const [msg, setMsg] = useState<string | null>(null);

    const goto = async (idx: number, name: string) => {
        setMsg(`→ ${name || `Preset ${idx}`}`);
        try {
            await milesightPTZGoto(cameraId, idx);
            setTimeout(() => setMsg(null), 2500);
        } catch {
            setMsg('preset failed');
            setTimeout(() => setMsg(null), 2500);
        }
    };

    const presets = data?.presetInfoList ?? [];

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 340 }}>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>
                PRESETS{msg ? ` · ${msg}` : ''}
            </span>
            {loading ? (
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>Loading…</span>
            ) : error ? (
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>unavailable</span>
            ) : presets.length === 0 ? (
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>No presets (save via camera UI)</span>
            ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxWidth: 340 }}>
                    {presets.map(p => (
                        <button
                            key={p.presetIndex}
                            onClick={() => goto(p.presetIndex, p.presetName)}
                            title={p.presetName || `Preset ${p.presetIndex}`}
                            style={{
                                background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
                                color: '#fff', borderRadius: 5, padding: '4px 8px', fontSize: 11,
                                cursor: 'pointer', fontFamily: 'inherit', maxWidth: 130,
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}
                        >
                            {p.presetName || `#${p.presetIndex}`}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
