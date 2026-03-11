import { useRef, useEffect, useState } from 'preact/hooks';
import { Window, WS_CAPTION, WS_SYSMENU } from './win2k/Window';

export function FindDialog({ findTerm, onTermChange, onFindNext, onClose, focused, parentRef }: {
  findTerm: string;
  onTermChange: (v: string) => void;
  onFindNext: () => void;
  onClose: () => void;
  focused?: boolean;
  parentRef?: { current: HTMLDivElement | null };
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [initPos] = useState<{ x: number; y: number }>(() => {
    const p = parentRef?.current?.getBoundingClientRect();
    const cx = p ? p.left + p.width / 2 : window.innerWidth / 2;
    const cy = p ? p.top + 60 : 80;
    return { x: Math.max(0, cx - 175), y: cy };
  });

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); onFindNext(); }
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  const btnStyle = {
    minWidth: '72px', height: '23px',
    background: '#D4D0C8', cursor: 'var(--win2k-cursor)',
    border: '1px solid', borderColor: '#FFF #404040 #404040 #FFF',
    boxShadow: 'inset 1px 1px 0 #D4D0C8, inset -1px -1px 0 #808080',
    fontFamily: '"Tahoma", "MS Sans Serif", sans-serif', fontSize: '11px',
  };

  return (
    <div style={{ position: 'fixed', left: '0', top: '0', zIndex: 10000 }}>
      <Window
        title="Find"
        style={WS_CAPTION | WS_SYSMENU}
        clientW={370}
        clientH={56}
        focused={focused}
        onClose={onClose}
        draggable
        initialPos={initPos}
      >
        <div style={{ padding: '8px', display: 'flex', gap: '8px', alignItems: 'center', fontFamily: '"Tahoma", "MS Sans Serif", sans-serif', fontSize: '11px' }}>
          <label style={{ whiteSpace: 'nowrap' }}>Find what:</label>
          <input
            ref={inputRef}
            type="text"
            value={findTerm}
            onInput={(e) => onTermChange((e.target as HTMLInputElement).value)}
            onKeyDown={handleKeyDown}
            style={{ flex: 1, height: '21px', border: '1px solid #7f9db9', padding: '1px 4px', fontFamily: 'inherit', fontSize: 'inherit', background: '#FFF' }}
          />
          <button
            onClick={onFindNext}
            disabled={!findTerm}
            style={btnStyle}
          >Find Next</button>
          <button
            onClick={onClose}
            style={btnStyle}
          >Cancel</button>
        </div>
      </Window>
    </div>
  );
}
