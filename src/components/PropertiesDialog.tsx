import { useEffect, useRef } from 'preact/hooks';
import { t } from '../lib/regional-settings';
import { Window, WS_CAPTION, WS_SYSMENU } from './win2k/Window';
import { Button } from './win2k/Button';
import { fileIcon32 } from './win2k/file-icons';

export interface PropertiesInfo {
  displayName: string;
  isFolder: boolean;
  isExe: boolean;
  iconUrl: string | null;
  size: number;
  addedAt: number;
  location: string;
  folderContents?: { files: number; folders: number; totalSize: number } | null;
  multiCount?: number;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB (${bytes.toLocaleString()} bytes)`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB (${bytes.toLocaleString()} bytes)`;
}

function getFileTypeName(name: string, isExe: boolean, isFolderEntry: boolean): string {
  if (isFolderEntry) return t().propFileFolder;
  if (isExe) return t().propApplication;
  const ext = name.split('.').pop()?.toUpperCase();
  return ext ? `${ext} File` : 'File';
}

function PropRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
      <div style={{ width: '90px', flexShrink: 0, color: '#000', textAlign: 'right' }}>{label}</div>
      <div style={{ flex: 1, wordBreak: 'break-all' }}>{value}</div>
    </div>
  );
}

export function PropertiesDialog({ info, flashTrigger, onClose }: {
  info: PropertiesInfo;
  flashTrigger: number;
  onClose: () => void;
}) {
  const fc = info.folderContents;
  const multi = info.multiCount != null && info.multiCount > 1;
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => { dialogRef.current?.focus(); }, []);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onPointerDown={(e) => { e.preventDefault(); /* flash handled by parent */ }}
      onContextMenu={(e: Event) => e.preventDefault()}>
      <div ref={dialogRef} tabIndex={-1} onKeyDown={onKeyDown} onPointerDown={(e) => e.stopPropagation()} style={{ font: '11px/1 "Tahoma", "MS Sans Serif", sans-serif', minWidth: '320px', maxWidth: '420px', outline: 'none' }}>
        <Window title={`${info.displayName} ${t().properties}`} style={WS_CAPTION | WS_SYSMENU} focused={true} draggable flashTrigger={flashTrigger} onClose={onClose}>
          {/* Icon + name */}
          <div style={{ padding: '12px 16px 8px', display: 'flex', gap: '10px', alignItems: 'center', borderBottom: '1px solid #808080' }}>
            <div style={{ flexShrink: 0 }}>
              {multi
                ? <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect x='2' y='6' width='20' height='24' rx='1' fill='%23fff' stroke='%23000' stroke-width='1.5'/%3E%3Crect x='10' y='2' width='20' height='24' rx='1' fill='%23fff' stroke='%23000' stroke-width='1.5'/%3E%3Cline x1='14' y1='9' x2='26' y2='9' stroke='%23808080'/%3E%3Cline x1='14' y1='13' x2='26' y2='13' stroke='%23808080'/%3E%3Cline x1='14' y1='17' x2='26' y2='17' stroke='%23808080'/%3E%3C/svg%3E" width="32" height="32" />
                : fileIcon32(info.displayName, { isFolder: info.isFolder, iconUrl: info.iconUrl })
              }
            </div>
            <div style={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{info.displayName}</div>
          </div>
          {/* Properties rows */}
          <div style={{ padding: '10px 16px 6px' }}>
            {!multi && (
              <PropRow label={t().propType} value={getFileTypeName(info.displayName, info.isExe, info.isFolder)} />
            )}
            <PropRow label={t().propLocation} value={info.location} />
            <PropRow label={t().propSize} value={
              !multi && info.isFolder
                ? (fc ? formatFileSize(fc.totalSize) : '...')
                : formatFileSize(info.size)
            } />
            {!multi && info.isFolder && fc && (
              <PropRow label={t().propContains} value={
                t().propFilesAndFolders.replace('{0}', String(fc.files)).replace('{1}', String(fc.folders))
              } />
            )}
            {!multi && info.addedAt > 0 && (
              <PropRow label={t().propCreated} value={new Date(info.addedAt).toLocaleString()} />
            )}
          </div>
          {/* OK button */}
          <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 16px 10px' }}>
            <div style={{ width: '75px', height: '23px', cursor: 'var(--win2k-cursor)' }} onClick={onClose}>
              <Button fontCSS='11px/1 "Tahoma", "MS Sans Serif", sans-serif' isDefault>{t().ok}</Button>
            </div>
          </div>
        </Window>
      </div>
    </div>
  );
}
