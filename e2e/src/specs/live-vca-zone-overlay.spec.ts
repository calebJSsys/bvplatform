import { test, expect, expectNoErrorBoundary } from '../fixtures';
import { authFile } from '../helpers/auth';
import { recordLiveTraffic } from '../helpers/video';

// Proof for feat/live-vca-zone-overlay: VideoPlayer overlays a camera's
// configured VCA detection zones over the LIVE feed as SVG, toggleable.
//
// Test camera: the remaining VCA-capable TEST-fleet PTZ camera (527 —
// Milesight PTZ with VCA zones), resolved by name at runtime. We NEVER use
// 504, 5001, or 577 — all are live CUSTOMER sites. We read the VCA camera's
// drawable zone count straight from the API (the same data source the overlay
// consumes), put it + a 0-zone non-customer camera in a 2-up static grid, then:
//   1) zones default ON -> the overlay draws >= (one shape per drawable rule);
//   2) toggle OFF -> shapes disappear from every tile (persisted to LS);
//   3) toggle back ON -> shapes return;
//   4) the 0-zone camera never renders any overlay.
// The expected count is derived from the live API rather than hardcoded so
// the proof stays valid as the test DB's VCA config changes. The overlay is
// independent of HEVC decode, so this passes even when the bundled Chromium
// can't decode the stream (the SVG renders regardless).

test.use({ storageState: authFile('admin') });

// 504, 5001, and 577 are live customer sites — exclude them from every selection.
const isCustomerCam = (name: string) =>
    /(^|\W)504(\W|$)/.test(name) || /(^|\W)5001(\W|$)/.test(name) || /(^|\W)577(\W|$)/.test(name);
// The primary VCA subject is the remaining test-fleet PTZ camera (527).
const isVcaTestCam = (name: string) =>
    /(^|\W)527(\W|$)/.test(name);

// Same client-side layout seeding as nvr.spec.ts: a fresh context has no
// saved layout, so we pre-seed a static 2-slot layout assigning our two
// cameras before any page script runs.
function staticLayout(cameraIds: string[]) {
    const staticAssignments: Record<number, string> = {};
    cameraIds.forEach((id, i) => { staticAssignments[i] = id; });
    return [{
        name: 'e2e-vca',
        items: [],
        cols: 2,
        version: 3,
        mode: 'static',
        staticPreset: { w: 2, h: 1 },
        staticAssignments,
    }];
}

// Count the zone shapes (polygons + lines) inside a given .video-cell's
// live VCA overlay SVG. Returns 0 when no overlay is present.
async function zoneShapeCount(cell: import('@playwright/test').Locator): Promise<number> {
    const polys = await cell.locator('svg polygon').count();
    const lines = await cell.locator('svg line').count();
    return polys + lines;
}

test.describe('Live VCA zone overlay @core', () => {
    test('a test-fleet VCA camera renders its zones over live, toggle works, 0-zone camera is clean', async ({ page }) => {
        test.setTimeout(120_000);

        // Resolve the camera inventory; the admin request context shares cookies.
        const camerasRes = await page.request.get('/api/cameras');
        expect(camerasRes.ok(), `GET /api/cameras -> HTTP ${camerasRes.status()}`).toBeTruthy();
        const cameras = (await camerasRes.json()) as { id: string; name: string }[];

        // Helper: count an individual camera's drawable VCA zones via the API.
        const drawableZoneCount = async (id: string): Promise<number> => {
            const r = await page.request.get(`/api/cameras/${id}/vca/rules`);
            if (!r.ok()) return -1;
            const rr = (await r.json()) as { enabled: boolean; region: unknown[] }[];
            return rr.filter(x => x.enabled && Array.isArray(x.region) && x.region.length >= 2).length;
        };

        // Pick the PRIMARY VCA subject: the remaining test-fleet PTZ camera (527)
        // that actually has at least one drawable VCA zone. Resolved by name at
        // runtime — never the 504/5001 customer sites.
        const vcaCandidates = cameras.filter(c => isVcaTestCam(c.name) && !isCustomerCam(c.name));
        let front: { id: string; name: string } | undefined;
        let expectedZones = 0;
        for (const c of vcaCandidates) {
            const n = await drawableZoneCount(c.id);
            if (n >= 1) { front = c; expectedZones = n; break; }
        }
        test.skip(
            !front,
            'no test-fleet VCA camera (527) with a drawable zone is registered '
            + `— cannot prove the overlay without touching a 504/5001/577 customer site. `
            + `(candidates: ${vcaCandidates.map(c => c.name).join(', ') || 'none'})`,
        );
        test.info().annotations.push({ type: 'vca-rules', description: `${front!.name}: ${expectedZones} drawable zone(s) (API)` });
        // The chosen camera must have at least one drawable zone, otherwise
        // there is nothing to prove the overlay against.
        expect(expectedZones, `${front!.name} must have >=1 drawable VCA zone to overlay`).toBeGreaterThanOrEqual(1);

        // Pick a 0-zone camera as the negative control. Any non-customer
        // camera with 0 drawable zones works; never a 504/5001 customer site.
        let zeroZoneCam: { id: string; name: string } | undefined;
        for (const c of cameras) {
            if (c.id === front!.id || isCustomerCam(c.name)) continue;
            const d = await drawableZoneCount(c.id);
            if (d === 0) { zeroZoneCam = c; break; }
        }
        expect(zeroZoneCam, 'need a second non-customer camera with 0 zones as negative control').toBeTruthy();

        // Seed a 2-up static layout: the VCA camera in slot 0, the 0-zone cam in slot 1.
        // Force zones ON regardless of any persisted preference from a prior run.
        await page.addInitScript(([layouts, active]) => {
            localStorage.setItem('ironsight-layouts', layouts);
            localStorage.setItem('ironsight-active-layout', active);
            localStorage.setItem('ironsight-vca-zones-visible', 'on');
        }, [JSON.stringify(staticLayout([front!.id, zeroZoneCam!.id])), 'e2e-vca'] as const);

        const traffic = recordLiveTraffic(page);
        await page.goto('/');
        await expect(page.locator('.video-cell').first()).toBeVisible({ timeout: 20_000 });

        // Locate the two cells by their displayed camera name.
        const frontCell = page.locator('.video-cell', { hasText: front!.name }).first();
        const zeroCell = page.locator('.video-cell', { hasText: zeroZoneCam!.name }).first();
        await expect(frontCell).toBeVisible();
        await expect(zeroCell).toBeVisible();

        // ── 1) Zones default ON: the VCA camera draws its zone shapes. ──
        // The overlay only renders once the stream is painting (not loading);
        // poll for the SVG shapes to appear. Independent of HEVC decode — the
        // SVG is a sibling of <video>, gated only on isLive && showZones &&
        // !loading && zones.length>0.
        await expect.poll(
            async () => zoneShapeCount(frontCell),
            { timeout: 30_000, message: `${front!.name} should render its VCA zone shapes` },
        ).toBeGreaterThanOrEqual(1);

        const onCount = await zoneShapeCount(frontCell);
        test.info().annotations.push({ type: 'zones-on', description: `${front!.name} zone shapes ON: ${onCount} (expected >=${expectedZones})` });
        // One shape per drawable rule minimum (a tripwire adds an extra
        // direction-arrow <line>, so the count can exceed the rule count).
        expect(onCount, 'should render at least one shape per drawable rule').toBeGreaterThanOrEqual(expectedZones);

        // Assert the overlay SVG covers the cell (bounds sanity — zones sit
        // over the video rect, not off-screen).
        const frontBox = await frontCell.boundingBox();
        const svgBox = await frontCell.locator('svg').first().boundingBox();
        expect(frontBox && svgBox, 'cell + overlay SVG should both have layout boxes').toBeTruthy();
        if (frontBox && svgBox) {
            expect(svgBox.x).toBeGreaterThanOrEqual(frontBox.x - 1);
            expect(svgBox.y).toBeGreaterThanOrEqual(frontBox.y - 1);
            expect(svgBox.width).toBeLessThanOrEqual(frontBox.width + 2);
        }

        // ── 4) 0-zone camera: never any overlay. ──
        expect(await zoneShapeCount(zeroCell), '0-zone camera must render no zone shapes').toBe(0);

        // ── 2) Toggle OFF via the ZONES header button -> shapes vanish on every tile. ──
        const zonesBtn = frontCell.getByRole('button', { name: 'ZONES' });
        await expect(zonesBtn).toBeVisible();
        await zonesBtn.click();
        await expect.poll(
            async () => zoneShapeCount(frontCell),
            { timeout: 5_000, message: 'zones should disappear after toggling OFF' },
        ).toBe(0);
        // localStorage reflects the OFF state (persisted + broadcast).
        const persistedOff = await page.evaluate(() => localStorage.getItem('ironsight-vca-zones-visible'));
        expect(persistedOff, 'toggle OFF should persist to localStorage').toBe('off');

        // ── 3) Toggle back ON -> shapes return. ──
        await zonesBtn.click();
        await expect.poll(
            async () => zoneShapeCount(frontCell),
            { timeout: 10_000, message: 'zones should return after toggling back ON' },
        ).toBeGreaterThanOrEqual(expectedZones);

        await expectNoErrorBoundary(page);
    });
});
