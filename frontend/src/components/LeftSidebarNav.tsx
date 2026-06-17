'use client';

// M1.5 — unified Company › Site › Camera tree-nav shell (MVP slice).
//
// Pure-frontend assembly over existing endpoints: useSites (sites carry
// company_id + online/total counts), useCompanies (names), useMasterCameras
// (cameras carry site_id + status). Role-filtered by assigned_site_ids.
//
// Behaviour:
//   • "All cameras" / company chevron / site chevron = expand-collapse.
//   • Click a SITE label  → scopes the grid (parent navigates to ?site_id=).
//   • Click a CAMERA       → scopes to its site + selects it.
// Camera-level nodes are grouped client-side from useMasterCameras (cheap for
// a test fleet); per-site lazy fetch is a later optimisation.

import { useMemo, useState } from 'react';
import { useSites } from '@/hooks/useSites';
import { useCompanies } from '@/hooks/useCustomers';
import { useMasterCameras } from '@/hooks/useCameraAssignment';
import { useAuth } from '@/contexts/AuthContext';
import type { SiteSummary } from '@/types/ironsight';

interface LeftSidebarNavProps {
    selectedSiteId: string | null;
    selectedCameraId: string | null;
    onSelectSite: (siteId: string | null) => void;
    onSelectCamera: (cameraId: string, siteId: string) => void;
}

// Roles that see the whole fleet; everyone else is scoped to assigned_site_ids.
const FULL_FLEET_ROLES = new Set(['admin', 'soc_operator', 'soc_supervisor']);
const UNGROUPED = '__ungrouped__';

function isOnline(status: string): boolean {
    return status === 'online' || status === 'connected';
}

export default function LeftSidebarNav({
    selectedSiteId,
    selectedCameraId,
    onSelectSite,
    onSelectCamera,
}: LeftSidebarNavProps) {
    const { user } = useAuth();
    const { data: sites } = useSites();
    const { data: companies } = useCompanies();
    const { data: cameras } = useMasterCameras();
    const [collapsed, setCollapsed] = useState(false);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    // Role filter: full-fleet roles see all sites; others only their assigned ones.
    const visibleSites = useMemo<SiteSummary[]>(() => {
        const all = sites ?? [];
        if (!user || FULL_FLEET_ROLES.has(user.role)) return all;
        const allowed = new Set(user.assigned_site_ids ?? []);
        return all.filter(s => allowed.has(s.id));
    }, [sites, user]);

    // cameras grouped by site_id (unassigned cameras are skipped)
    const camsBySite = useMemo(() => {
        const m = new Map<string, { id: string; name: string; status: string }[]>();
        for (const c of cameras ?? []) {
            if (!c.site_id) continue;
            const arr = m.get(c.site_id) ?? [];
            arr.push({ id: c.id, name: c.name, status: c.status });
            m.set(c.site_id, arr);
        }
        return m;
    }, [cameras]);

    // group visible sites under their company (sites with no company_id → Ungrouped)
    const groups = useMemo(() => {
        const byCompany = new Map<string, SiteSummary[]>();
        for (const s of visibleSites) {
            const key = s.company_id ?? UNGROUPED;
            const arr = byCompany.get(key) ?? [];
            arr.push(s);
            byCompany.set(key, arr);
        }
        const out = Array.from(byCompany.entries()).map(([cid, csites]) => ({
            id: cid,
            name: cid === UNGROUPED ? 'Ungrouped' : (companies?.find(c => c.id === cid)?.name ?? 'Company'),
            sites: csites.slice().sort((a, b) => a.name.localeCompare(b.name)),
        }));
        out.sort((a, b) =>
            (a.id === UNGROUPED ? 1 : 0) - (b.id === UNGROUPED ? 1 : 0) || a.name.localeCompare(b.name));
        return out;
    }, [visibleSites, companies]);

    const toggle = (id: string) =>
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });

    if (collapsed) {
        return (
            <div className="sidebar-nav sidebar-collapsed">
                <button className="sidebar-toggle" title="Show navigation" onClick={() => setCollapsed(false)}>›</button>
            </div>
        );
    }

    return (
        <div className="sidebar-nav">
            <div className="sidebar-header">
                <span>Navigator</span>
                <button className="sidebar-toggle" title="Hide navigation" onClick={() => setCollapsed(true)}>‹</button>
            </div>
            <div className="sidebar-tree">
                <button
                    className={`tree-row ${selectedSiteId === null ? 'tree-selected' : ''}`}
                    onClick={() => onSelectSite(null)}
                    title="Show all cameras"
                >
                    <span className="tree-icon">▦</span>
                    <span className="tree-label">All cameras</span>
                </button>

                {groups.map(group => {
                    const gOpen = expanded.has(group.id);
                    return (
                        <div key={group.id} className="tree-company">
                            <button className="tree-row tree-company-row" onClick={() => toggle(group.id)}>
                                <span className={`tree-chevron ${gOpen ? 'open' : ''}`}>▸</span>
                                <span className="tree-icon">🏢</span>
                                <span className="tree-label">{group.name}</span>
                                <span className="tree-count">{group.sites.length}</span>
                            </button>

                            {gOpen && group.sites.map(site => {
                                const sOpen = expanded.has(site.id);
                                const cams = camsBySite.get(site.id) ?? [];
                                return (
                                    <div key={site.id} className="tree-site">
                                        <div className={`tree-row tree-site-row ${selectedSiteId === site.id ? 'tree-selected' : ''}`}>
                                            <button
                                                className={`tree-chevron ${sOpen ? 'open' : ''}`}
                                                onClick={() => toggle(site.id)}
                                                title="Expand cameras"
                                            >▸</button>
                                            <button
                                                className="tree-site-label"
                                                onClick={() => onSelectSite(site.id)}
                                                title={`Scope grid to ${site.name}`}
                                            >
                                                <span className="tree-icon">📍</span>
                                                <span className="tree-label">{site.name}</span>
                                                <span className="tree-count">{site.cameras_online}/{site.cameras_total}</span>
                                            </button>
                                        </div>
                                        {sOpen && (cams.length > 0
                                            ? cams.map(cam => (
                                                <button
                                                    key={cam.id}
                                                    className={`tree-row tree-camera-row ${selectedCameraId === cam.id ? 'tree-selected' : ''}`}
                                                    onClick={() => onSelectCamera(cam.id, site.id)}
                                                    title={cam.name}
                                                >
                                                    <span className={`cam-dot ${isOnline(cam.status) ? 'online' : 'offline'}`} />
                                                    <span className="tree-label">{cam.name}</span>
                                                </button>
                                            ))
                                            : <div className="tree-empty">No cameras</div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    );
                })}

                {groups.length === 0 && <div className="tree-empty">No sites available</div>}
            </div>
        </div>
    );
}
