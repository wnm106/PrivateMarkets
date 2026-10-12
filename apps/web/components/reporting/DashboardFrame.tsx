'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { buildDashboardSrcDoc } from './frameRuntime';
import type { DataQueryPayload } from '@/lib/reporting';

interface DashboardFrameProps {
  html: string;
  payload: DataQueryPayload | null;
  minHeight?: number;
  onSetParam?: (name: string, value: any) => void;
  onScriptError?: (message: string) => void;
}

/**
 * Renders custom dashboard HTML in a sandboxed iframe (scripts allowed, opaque origin,
 * network blocked by CSP) and feeds it data over postMessage.
 */
export function DashboardFrame({ html, payload, minHeight = 160, onSetParam, onScriptError }: DashboardFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const payloadRef = useRef<DataQueryPayload | null>(payload);
  const [height, setHeight] = useState(minHeight);
  const srcDoc = useMemo(() => buildDashboardSrcDoc(html), [html]);

  const post = () => {
    const win = iframeRef.current?.contentWindow;
    if (win && readyRef.current && payloadRef.current) {
      win.postMessage({ type: 'tapestr:data', payload: payloadRef.current }, '*');
    }
  };

  // New HTML => new document => wait for its ready signal again.
  useEffect(() => {
    readyRef.current = false;
  }, [srcDoc]);

  useEffect(() => {
    payloadRef.current = payload;
    post();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only trust messages from OUR iframe.
      if (e.source !== iframeRef.current?.contentWindow) return;
      const msg = e.data;
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'tapestr:ready':
          readyRef.current = true;
          post();
          break;
        case 'tapestr:resize':
          if (typeof msg.height === 'number') setHeight(Math.max(minHeight, Math.min(msg.height + 4, 4000)));
          break;
        case 'tapestr:setParam':
          if (typeof msg.name === 'string') onSetParam?.(msg.name, msg.value);
          break;
        case 'tapestr:error':
          onScriptError?.(String(msg.message ?? 'Script error'));
          break;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minHeight, onSetParam, onScriptError]);

  return (
    <iframe
      ref={iframeRef}
      title="Dashboard"
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      style={{ width: '100%', height, border: '1px solid var(--line)', background: 'white', display: 'block' }}
    />
  );
}
