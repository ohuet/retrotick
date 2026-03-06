import { useState, useRef } from 'preact/hooks';
import { Window, WS_CAPTION, WS_SYSMENU, WS_MINIMIZEBOX } from './win2k/Window';
import { Button } from './win2k/Button';
import {
  loadSettings, saveSettings, getLocalePresets, getKeyboardLayouts,
  getLocalePreset, settingsFromPreset, t,
  type RegionalSettings,
} from '../lib/regional-settings';

const FONT = '11px "Tahoma", sans-serif';

const selectStyle: Record<string, string | number> = {
  width: '100%', height: '21px', boxSizing: 'border-box',
  background: '#FFF',
  border: '1px solid', borderColor: '#808080 #FFF #FFF #808080',
  font: FONT, padding: '1px 2px',
  outline: 'none',
};

const inputStyle: Record<string, string | number> = {
  width: '100%', height: '21px', boxSizing: 'border-box',
  background: '#FFF',
  border: '1px solid', borderColor: '#808080 #FFF #FFF #808080',
  boxShadow: 'inset 1px 1px 0 #404040',
  font: FONT, padding: '1px 4px',
  outline: 'none',
};

const shortInputStyle: Record<string, string | number> = {
  ...inputStyle, width: '60px',
};

interface RegionalSettingsWindowProps {
  onClose: () => void;
  onFocus: () => void;
  onMinimize: () => void;
  zIndex: number;
  focused: boolean;
  minimized: boolean;
}

export function RegionalSettingsWindow({ onClose, onFocus, onMinimize, zIndex, focused, minimized }: RegionalSettingsWindowProps) {
  const [settings, setSettings] = useState<RegionalSettings>(loadSettings);
  const localePresets = getLocalePresets();
  const kbLayouts = getKeyboardLayouts();
  const initialPos = useRef({ x: Math.max(0, (window.innerWidth - 340) / 2), y: Math.max(0, (window.innerHeight - 380) / 2) });

  const handleLocaleChange = (localeId: number) => {
    const preset = getLocalePreset(localeId);
    setSettings(settingsFromPreset(preset));
  };

  const formatPreview = (s: RegionalSettings): string => {
    const intPart = '123456789';
    const sep = s.thousandsSep;
    let formatted = '';
    for (let i = 0; i < intPart.length; i++) {
      const pos = intPart.length - 1 - i;
      if (i > 0 && i % 3 === 0) formatted = sep + formatted;
      formatted = intPart[pos] + formatted;
    }
    return formatted + s.decimalSep + '00';
  };

  const formatDatePreview = (s: RegionalSettings): string => {
    const preset = getLocalePreset(s.localeId);
    const now = new Date();
    // Simple preview: replace format tokens with actual values
    let result = s.shortDateFmt;
    result = result.replace(/yyyy/g, String(now.getFullYear()));
    result = result.replace(/yy/g, String(now.getFullYear() % 100).padStart(2, '0'));
    result = result.replace(/MMMM/g, preset.monthNames[now.getMonth()]);
    result = result.replace(/MMM/g, preset.monthAbbr[now.getMonth()]);
    result = result.replace(/MM/g, String(now.getMonth() + 1).padStart(2, '0'));
    result = result.replace(/(?<!M)M(?!M)/g, String(now.getMonth() + 1));
    result = result.replace(/dd/g, String(now.getDate()).padStart(2, '0'));
    result = result.replace(/(?<!d)d(?!d)/g, String(now.getDate()));
    return result;
  };

  const handleOK = () => {
    saveSettings(settings);
    onClose();
  };

  const labelStyle = { font: FONT, marginBottom: '3px' };

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex, display: minimized ? 'none' : undefined, pointerEvents: 'none' }} onPointerDown={onFocus}>
      <div style={{ pointerEvents: 'auto', display: 'inline-block' }}>
        <Window
          title={t().regionalSettings}
          style={WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX}
          clientW={320}
          focused={focused}
          minimized={minimized}
          onClose={onClose}
          onMinimize={onMinimize}
          draggable
          initialPos={initialPos.current}
        >
          <div style={{ background: '#D4D0C8', padding: '12px 14px' }}>
            {/* Locale */}
            <div style={{ marginBottom: '8px' }}>
              <div style={labelStyle}>{t().labelLocale}</div>
              <select
                style={selectStyle}
                value={settings.localeId}
                onChange={(e) => handleLocaleChange(parseInt((e.target as HTMLSelectElement).value))}
              >
                {localePresets.map(p => (
                  <option key={p.localeId} value={p.localeId}>{p.name}</option>
                ))}
              </select>
            </div>

            {/* Keyboard layout */}
            <div style={{ marginBottom: '8px' }}>
              <div style={labelStyle}>{t().labelKeyboard}</div>
              <select
                style={selectStyle}
                value={settings.keyboardLayout}
                onChange={(e) => setSettings(s => ({ ...s, keyboardLayout: (e.target as HTMLSelectElement).value }))}
              >
                {kbLayouts.map(l => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>

            {/* Separators */}
            <div style={{ display: 'flex', gap: '12px', marginBottom: '8px' }}>
              <div style={{ flex: 1 }}>
                <div style={labelStyle}>{t().labelDecimalSep}</div>
                <input
                  style={shortInputStyle}
                  value={settings.decimalSep}
                  maxLength={2}
                  onInput={(e) => setSettings(s => ({ ...s, decimalSep: (e.target as HTMLInputElement).value }))}
                />
              </div>
              <div style={{ flex: 1 }}>
                <div style={labelStyle}>{t().labelThousandsSep}</div>
                <input
                  style={shortInputStyle}
                  value={settings.thousandsSep}
                  maxLength={2}
                  onInput={(e) => setSettings(s => ({ ...s, thousandsSep: (e.target as HTMLInputElement).value }))}
                />
              </div>
            </div>

            {/* Date formats */}
            <div style={{ display: 'flex', gap: '12px', marginBottom: '8px' }}>
              <div style={{ flex: 1 }}>
                <div style={labelStyle}>{t().labelShortDate}</div>
                <input
                  style={inputStyle}
                  value={settings.shortDateFmt}
                  onInput={(e) => setSettings(s => ({ ...s, shortDateFmt: (e.target as HTMLInputElement).value }))}
                />
              </div>
              <div style={{ flex: 1 }}>
                <div style={labelStyle}>{t().labelTimeFormat}</div>
                <input
                  style={inputStyle}
                  value={settings.timeFmt}
                  onInput={(e) => setSettings(s => ({ ...s, timeFmt: (e.target as HTMLInputElement).value }))}
                />
              </div>
            </div>

            {/* Long date format */}
            <div style={{ marginBottom: '8px' }}>
              <div style={labelStyle}>{t().labelLongDate}</div>
              <input
                style={inputStyle}
                value={settings.longDateFmt}
                onInput={(e) => setSettings(s => ({ ...s, longDateFmt: (e.target as HTMLInputElement).value }))}
              />
            </div>

            {/* Preview */}
            <div style={{ marginBottom: '10px' }}>
              <div style={{ font: FONT, marginBottom: '3px', color: '#808080' }}>{t().labelPreview}</div>
              <div style={{
                font: FONT, padding: '4px 6px',
                background: '#FFF', border: '1px solid #808080',
                textAlign: 'center',
              }}>
                {formatPreview(settings)}{' \u00A0 '}{formatDatePreview(settings)}
              </div>
            </div>

            <div style={{ borderTop: '1px solid #808080', borderBottom: '1px solid #FFF', margin: '0 0 8px' }} />

            {/* Buttons */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px' }}>
              <div style={{ width: '75px', height: '23px' }} onClick={handleOK}>
                <Button fontCSS={FONT} isDefault>OK</Button>
              </div>
              <div style={{ width: '75px', height: '23px' }} onClick={onClose}>
                <Button fontCSS={FONT}>{t().cancel}</Button>
              </div>
            </div>
          </div>
        </Window>
      </div>
    </div>
  );
}
