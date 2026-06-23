import { test, expect } from '../fixtures';
import { authFile } from '../helpers/auth';

test.use({ storageState: authFile('admin') });

// ─────────────────────────────────────────────────────────────────────────
// Proof for fix/timeline-cross-camera-leak (active-layout scoping).
//
// Before the fix the playback timeline queried ALL loaded cameras, so a
// layout containing only the event-free cameras still showed an
// event-bearing camera's events. After the fix the timeline scopes to the
// cameras in the ACTIVE grid layout.
//
// This spec seeds two static layouts in localStorage (CameraGrid reads
// `ironsight-layouts` / `ironsight-active-layout`), captures every
// GET /api/timeline request, and asserts:
//   1. with the event-free layout active, camera_ids == exactly those
//      UUIDs and the timeline returns 0 buckets (those cams have no events);
//   2. after switching to the event-bearing layout, the next timeline
//      request carries that camera's UUID and returns >0 buckets.
//
// Camera selection is resolved at runtime from the live inventory and the
// event counts per camera. It NEVER selects the 5001 or 504 cameras — both
// are live CUSTOMER sites and must never be probed/streamed by the suite.
// ─────────────────────────────────────────────────────────────────────────

interface Cam { id: string; name: string; }

// 5001 and 504 are live customer sites — exclude them from every selection.
const isCustomerCam = (c: Cam) =>
    /(^|\W)504(\W|$)/.test(c.name) || /(^|\W)5001(\W|$)/.test(c.name);

function staticLayout(name: string, cameraIds: string[]) {
    const presets = [
        { w: 1, h: 1 }, { w: 2, h: 1 }, { w: 2, h: 2 }, { w: 3, h: 2 },
        { w: 3, h: 3 }, { w: 4, h: 3 }, { w: 4, h: 4 },
    ];
    const preset = presets.find(p => p.w * p.h >= cameraIds.length) ?? presets[presets.length - 1];
    const staticAssignments: Record<number, string> = {};
    cameraIds.forEach((id, i) => { staticAssignments[i] = id; });
    return { name, items: [], cols: preset.w, version: 3, mode: 'static', staticPreset: preset, staticAssignments };
}

/** Parse the camera_ids query param of a /api/timeline URL into a sorted array. */
function timelineCameraIds(url: string): string[] | null {
    const u = new URL(url);
    const raw = u.searchParams.get('camera_ids');
    if (raw === null) return null; // no filter at all (all cameras)
    return raw.split(',').filter(Boolean).sort();
}

test.describe('Timeline scopes to the active grid layout @core', () => {
    test('event-free layout queries only its cams (no event-bearing leak); event-bearing layout queries its cam', async ({ page }) => {
        test.setTimeout(120_000);

        // 1. Resolve the real camera UUIDs from the live inventory, then split
        //    them by whether they have events. We need two event-free cameras
        //    (the empty-timeline layout) and one event-bearing camera (the
        //    other layout). Never select 5001/504 (live customer sites).
        const res = await page.request.get('/api/cameras');
        expect(res.ok(), `GET /api/cameras -> ${res.status()}`).toBeTruthy();
        const cameras = ((await res.json()) as Cam[]).filter(c => !isCustomerCam(c));

        // Probe per-camera event counts so we can pick an event-free pair and
        // an event-bearing camera without hard-coding any names.
        const eventCount = async (id: string): Promise<number> => {
            const r = await page.request.get(`/api/events?camera_id=${id}&limit=1`);
            if (!r.ok()) return -1;
            const body = (await r.json()) as any[];
            return Array.isArray(body) ? body.length : -1;
        };
        const eventFree: Cam[] = [];
        const eventBearing: Cam[] = [];
        for (const c of cameras) {
            const n = await eventCount(c.id);
            if (n === 0) eventFree.push(c);
            else if (n > 0) eventBearing.push(c);
            // n < 0 (error) → skip this camera entirely.
        }

        // Two event-free cameras for the empty-timeline layout, one
        // event-bearing camera for the other half.
        const emptyCams = eventFree.slice(0, 2);
        const eventCam = eventBearing[0];
        test.skip(
            emptyCams.length < 2 || !eventCam,
            'inventory lacks two event-free cameras + one event-bearing camera (excluding 5001/504 customer sites) '
            + `— cannot prove layout scoping without touching a customer cam. `
            + `(event-free=${eventFree.length}, event-bearing=${eventBearing.length})`,
        );

        const idsEmpty = emptyCams.map(c => c.id).sort();
        const idsEvent = [eventCam!.id].sort();
        test.info().annotations.push({ type: 'cams-empty', description: idsEmpty.join(',') });
        test.info().annotations.push({ type: 'cams-event', description: idsEvent.join(',') });

        // 2. Seed both layouts before any page script runs; empty active first.
        const layouts = [
            staticLayout('e2e-empty-only', idsEmpty),
            staticLayout('e2e-events', idsEvent),
        ];
        await page.addInitScript(([ls, active]) => {
            localStorage.setItem('ironsight-layouts', ls as string);
            localStorage.setItem('ironsight-active-layout', active as string);
        }, [JSON.stringify(layouts), 'e2e-empty-only'] as const);

        // 3. Record every /api/timeline request URL + its response body.
        const timelineCalls: { ids: string[] | null; bucketCount: number; url: string }[] = [];
        page.on('response', async (resp) => {
            const url = resp.url();
            if (!/\/api\/timeline\?/.test(url)) return;
            let bucketCount = -1;
            try {
                const body = await resp.json();
                // TimelineBucket = { bucket_time, counts, total } — sum the
                // per-bucket totals to get the event count in the window.
                bucketCount = Array.isArray(body)
                    ? body.reduce((sum: number, b: any) => sum + (Number(b.total) || 0), 0)
                    : -1;
            } catch { /* non-JSON / aborted */ }
            timelineCalls.push({ ids: timelineCameraIds(url), bucketCount, url });
        });

        await page.goto('/');
        // The static grid renders one cell per assigned camera.
        await expect(page.locator('.video-cell').first()).toBeVisible({ timeout: 20_000 });
        await expect(page.locator('.timeline-container')).toBeVisible({ timeout: 15_000 });

        // 4. Wait for a timeline request that carries the event-free scope.
        await expect.poll(
            () => timelineCalls.some(c => c.ids && c.ids.length === 2
                && c.ids[0] === idsEmpty[0] && c.ids[1] === idsEmpty[1]),
            { timeout: 30_000, message: `no event-free-scoped /api/timeline seen. Calls: ${JSON.stringify(timelineCalls.map(c => c.ids))}` },
        ).toBeTruthy();

        const callEmpty = [...timelineCalls].reverse().find(c => c.ids && c.ids.length === 2);
        expect(callEmpty, 'a 2-camera (event-free) timeline call').toBeTruthy();
        // EXACTLY the two event-free UUIDs — nothing else leaked in.
        expect(callEmpty!.ids).toEqual(idsEmpty);
        // These cameras have no events, so the timeline must come back empty.
        expect(callEmpty!.bucketCount, `event-free timeline must have 0 events (got ${callEmpty!.bucketCount})`).toBe(0);

        // CRITICAL anti-leak assertion: NO event-free-active timeline request
        // may carry the event-bearing camera id.
        const leaked = timelineCalls.filter(c => c.ids && c.ids.includes(eventCam!.id));
        expect(leaked.length,
            `event-bearing camera id must NOT appear in an event-free-layout timeline request (leaks: ${JSON.stringify(leaked.map(l => l.ids))})`,
        ).toBe(0);

        // 5. Switch to the event-bearing layout via its toolbar chip.
        const before = timelineCalls.length;
        await page.getByRole('button', { name: /e2e-events/ }).click();

        await expect.poll(
            () => timelineCalls.slice(before).some(c => c.ids && c.ids.length === 1 && c.ids[0] === idsEvent[0]),
            { timeout: 30_000, message: `no event-bearing-scoped /api/timeline after switch. Calls: ${JSON.stringify(timelineCalls.slice(before).map(c => c.ids))}` },
        ).toBeTruthy();

        const callEvent = [...timelineCalls].reverse().find(c => c.ids && c.ids.length === 1 && c.ids[0] === idsEvent[0]);
        expect(callEvent, 'an event-bearing-scoped timeline call after switching layout').toBeTruthy();
        expect(callEvent!.ids).toEqual(idsEvent);
        // The event-bearing camera has events in the test DB.
        expect(callEvent!.bucketCount, `event-bearing timeline must have >0 events (got ${callEvent!.bucketCount})`).toBeGreaterThan(0);

        test.info().annotations.push({
            type: 'proof',
            description: `event-free call ids=${JSON.stringify(callEmpty!.ids)} buckets=${callEmpty!.bucketCount}; `
                + `event-bearing call ids=${JSON.stringify(callEvent!.ids)} buckets=${callEvent!.bucketCount}`,
        });
    });
});
