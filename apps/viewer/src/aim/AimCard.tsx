/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AIM card — platform (database) data for the selected element, rendered at
 * the top of the PropertiesPanel when the viewer is embedded in the AIM host.
 * Purely presentational: the host sends a generic render schema
 * (AimPanelData) and every link is bounced back over the bridge
 * (postAimNavigate) so navigation happens in the parent app, never here.
 * Renders nothing when standalone (not embedded) — zero upstream impact.
 */

import { Database, FileText, ExternalLink, Users, Camera, History } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useAimPanelStore, postAimNavigate, type AimPanelData } from './aimPanelStore';

function AimLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        e.preventDefault();
        postAimNavigate(href);
      }}
    >
      {children}
    </a>
  );
}

function AimCardBody({ data }: { data: AimPanelData }) {
  return (
    <div className="border-t">
      {/* Title + badges */}
      <div className="px-3 py-2 space-y-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-sm truncate" title={data.title}>{data.title}</span>
          {data.badges?.map((b) => (
            <Badge
              key={b.label}
              variant={b.tone === 'accent' ? 'default' : 'secondary'}
              className="text-[10px] px-1.5 py-0 shrink-0"
            >
              {b.label}
            </Badge>
          ))}
        </div>
        {data.subtitle && (
          <div className="font-mono text-[10px] text-muted-foreground truncate" title={data.subtitle}>
            {data.subtitle}
          </div>
        )}
      </div>

      {/* Generic sections */}
      {data.sections?.map((section) => (
        <div key={section.label}>
          <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {section.label}
          </div>
          <div className="divide-y border-t">
            {section.rows.map((row, i) => (
              <div key={`${row.label}-${i}`} className="grid grid-cols-[minmax(80px,1fr)_minmax(0,2fr)] gap-2 px-3 py-1.5 text-sm">
                <span className="text-muted-foreground truncate" title={row.label}>{row.label}</span>
                {row.href ? (
                  <AimLink href={row.href} className="font-medium truncate text-primary hover:underline" >
                    {row.value}
                  </AimLink>
                ) : (
                  <span className={`font-medium truncate ${row.mono ? 'font-mono text-xs' : ''}`} title={row.value}>
                    {row.value}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Documents */}
      {data.documents && data.documents.length > 0 && (
        <div>
          <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Dokumenty ({data.documents.length})
          </div>
          <div className="divide-y border-t">
            {data.documents.map((doc, i) => (
              <AimLink
                key={`${doc.href}-${i}`}
                href={doc.href}
                className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50 min-w-0"
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate flex-1" title={doc.name}>{doc.name}</span>
                {doc.badge && (
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">{doc.badge}</Badge>
                )}
              </AimLink>
            ))}
          </div>
        </div>
      )}

      {/* Responsibilities (v2, D-077) — who is responsible for the element */}
      {data.responsibilities && data.responsibilities.length > 0 && (
        <div>
          <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Zodpovednosti ({data.responsibilities.length})
          </div>
          <div className="divide-y border-t">
            {data.responsibilities.map((resp, i) => {
              const body = (
                <>
                  <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate" title={resp.name}>{resp.name}</span>
                  <span className="text-xs text-muted-foreground truncate shrink-0" title={resp.role}>
                    {resp.role}
                    {resp.org ? ` · ${resp.org}` : ''}
                  </span>
                </>
              );
              const cls = 'flex items-center gap-2 px-3 py-1.5 text-sm min-w-0';
              return resp.href ? (
                <AimLink key={`${resp.name}-${i}`} href={resp.href} className={`${cls} hover:bg-muted/50`}>
                  {body}
                </AimLink>
              ) : (
                <div key={`${resp.name}-${i}`} className={cls}>{body}</div>
              );
            })}
          </div>
        </div>
      )}

      {/* Reality Capture summary (v2, D-077) */}
      {data.captures && data.captures.count > 0 && (
        <AimLink
          href={data.captures.href}
          className="flex items-center gap-2 px-3 py-1.5 text-sm border-t hover:bg-muted/50 min-w-0"
        >
          <Camera className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate flex-1">Reality Capture ({data.captures.count})</span>
          <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
        </AimLink>
      )}

      {/* GUID history (v2, D-077) — bitemporal validity, read-only */}
      {data.history && data.history.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 px-3 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <History className="h-3 w-3" />
            História GUID ({data.history.length})
          </div>
          <div className="divide-y border-t">
            {data.history.map((h, i) => (
              <div key={`${h.guid}-${i}`} className="flex items-center gap-2 px-3 py-1 text-xs min-w-0">
                <span
                  className={`font-mono truncate ${h.active ? 'font-semibold' : 'text-muted-foreground'}`}
                  title={h.guid}
                >
                  {h.guid}
                </span>
                <span className="text-muted-foreground shrink-0 ml-auto">
                  {h.validFrom}
                  {h.validUntil ? ` – ${h.validUntil}` : h.active ? ' – teraz' : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      {data.actions && data.actions.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 py-2 border-t">
          {data.actions.map((action) => (
            <Button
              key={action.href}
              variant={action.primary ? 'default' : 'outline'}
              size="sm"
              className="h-7 text-xs gap-1.5"
              onClick={() => postAimNavigate(action.href)}
            >
              {action.label}
              <ExternalLink className="h-3 w-3" />
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

export function AimCard() {
  const embedded = useAimPanelStore((s) => s.embedded);
  const panel = useAimPanelStore((s) => s.panel);

  if (!embedded || panel.status === 'idle') return null;

  return (
    <Collapsible defaultOpen className="border-b border-l-2 border-l-amber-500">
      <CollapsibleTrigger className="flex items-center gap-2 w-full p-3 hover:bg-muted/50 text-left">
        <Database className="h-4 w-4 text-amber-600 dark:text-amber-500" />
        <span className="font-medium text-sm">AIM</span>
        <Badge variant="outline" className="text-[9px] px-1 py-0 uppercase tracking-wider border-amber-500/50 text-amber-700 dark:text-amber-400">
          platforma
        </Badge>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {panel.status === 'loading' && (
          <div className="border-t px-3 py-2 space-y-1.5 animate-pulse">
            <div className="h-3.5 w-2/3 rounded bg-muted" />
            <div className="h-3 w-1/2 rounded bg-muted" />
            <div className="h-3 w-3/5 rounded bg-muted" />
          </div>
        )}
        {panel.status === 'empty' && (
          <div className="border-t px-3 py-2 text-xs text-muted-foreground">
            Tento element nemá záznam v AIM databáze.
          </div>
        )}
        {panel.status === 'ready' && <AimCardBody data={panel.data} />}
      </CollapsibleContent>
    </Collapsible>
  );
}
