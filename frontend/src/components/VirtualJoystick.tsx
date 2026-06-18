'use client';

// Virtual PTZ joystick — a dumb pointer-driven input. Knob displacement from
// center maps to a normalized pan/tilt velocity (-1..1, up = +tilt) with a
// deadzone; the parent decides what to do with it (throttle → ptzMove). One
// Pointer Events path covers mouse + touch + pen; setPointerCapture keeps a
// drag tracking even when the pointer leaves the knob.

import { useCallback, useRef, useState } from 'react';

// Response-curve exponent: emitted speed = (normalized travel past deadzone)^EASE.
// >1 eases in — fine, slow control near center, full camera speed only near the
// rim — which curbs the overshoot a linear (EASE=1) map produces.
const EASE = 1.8;

interface VirtualJoystickProps {
    size?: number;        // base diameter in px
    deadzone?: number;    // 0..1 — fraction of travel ignored near center
    onMove: (pan: number, tilt: number) => void;  // normalized -1..1
    onEnd: () => void;
}

export default function VirtualJoystick({ size = 120, deadzone = 0.12, onMove, onEnd }: VirtualJoystickProps) {
    const baseRef = useRef<HTMLDivElement>(null);
    const activeRef = useRef(false);
    const [dragging, setDragging] = useState(false);
    const [knob, setKnob] = useState({ x: 0, y: 0 });
    const radius = size / 2;
    const knobSize = Math.round(size * 0.42);

    const compute = useCallback((clientX: number, clientY: number) => {
        const base = baseRef.current;
        if (!base) return;
        const rect = base.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        let dx = clientX - cx;
        let dy = clientY - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > radius) { dx = (dx / dist) * radius; dy = (dy / dist) * radius; }
        setKnob({ x: dx, y: dy });
        const nx = dx / radius;
        const ny = -dy / radius;                 // invert Y so up = +tilt
        const mag = Math.hypot(nx, ny);
        if (mag < deadzone) { onMove(0, 0); return; }
        // Rescale travel past the deadzone to 0..1, then ease-in (^EASE): modest
        // pulls → slow fine velocity, only a near-full deflection → full speed.
        const m = Math.min(1, (mag - deadzone) / (1 - deadzone));
        const speed = Math.pow(m, EASE);
        const ux = nx / mag, uy = ny / mag;      // unit direction (knob visual still tracks the finger)
        onMove(Math.max(-1, Math.min(1, ux * speed)), Math.max(-1, Math.min(1, uy * speed)));
    }, [radius, deadzone, onMove]);

    const down = (e: React.PointerEvent) => {
        e.preventDefault();
        baseRef.current?.setPointerCapture(e.pointerId);
        activeRef.current = true;
        setDragging(true);
        compute(e.clientX, e.clientY);
    };
    const move = (e: React.PointerEvent) => { if (activeRef.current) compute(e.clientX, e.clientY); };
    const end = () => {
        if (!activeRef.current) return;
        activeRef.current = false;
        setDragging(false);
        setKnob({ x: 0, y: 0 });
        onEnd();
    };

    return (
        <div
            ref={baseRef}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onLostPointerCapture={end}
            style={{
                width: size, height: size, borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(255,255,255,0.10), rgba(0,0,0,0.4))',
                border: '1px solid rgba(255,255,255,0.18)', position: 'relative',
                touchAction: 'none', cursor: dragging ? 'grabbing' : 'grab', flexShrink: 0,
            }}
            aria-label="PTZ joystick"
        >
            <div style={{ position: 'absolute', left: '50%', top: 8, bottom: 8, width: 1, background: 'rgba(255,255,255,0.08)' }} />
            <div style={{ position: 'absolute', top: '50%', left: 8, right: 8, height: 1, background: 'rgba(255,255,255,0.08)' }} />
            <div style={{
                position: 'absolute', width: knobSize, height: knobSize, borderRadius: '50%',
                left: '50%', top: '50%',
                transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))`,
                background: dragging ? 'rgba(232,115,42,0.9)' : 'rgba(232,115,42,0.6)',
                border: '2px solid rgba(255,255,255,0.5)', boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
                transition: dragging ? 'none' : 'transform 0.12s ease', pointerEvents: 'none',
            }} />
        </div>
    );
}
