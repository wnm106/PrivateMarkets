'use client';

import { useTemporalStore } from '@/lib/store';
import Link from 'next/link';
import { useState, useRef, useEffect, useCallback } from 'react';

export function TopBar() {
  const { persona, setPersona } = useTemporalStore();
  const [showAdminMenu, setShowAdminMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the admin dropdown when clicking outside of it
  const handleClickOutside = useCallback((event: MouseEvent) => {
    if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
      setShowAdminMenu(false);
    }
  }, []);

  useEffect(() => {
    if (showAdminMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showAdminMenu, handleClickOutside]);

  return (
    <div className="topbar">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <Link href="/" style={{ textDecoration: 'none' }}>
          <div className="brand">
            <div className="brand-mark">M</div>
            <div>
              <div className="brand-text">Meridian</div>
            </div>
            <div className="brand-sub">Master Data · v2.4</div>
          </div>
        </Link>
        <div className="role-tabs">
          <button
            className={`role-tab ${persona === 'steward' ? 'active' : ''}`}
            onClick={() => setPersona('steward')}
          >
            Data Steward
          </button>
          <button
            className={`role-tab ${persona === 'ops' ? 'active' : ''}`}
            onClick={() => setPersona('ops')}
          >
            Operations Analyst
          </button>
          <button
            className={`role-tab ${persona === 'governance' ? 'active' : ''}`}
            onClick={() => setPersona('governance')}
          >
            Governance Lead
          </button>
        </div>
      </div>
      <div className="topbar-right" style={{ position: 'relative', zIndex: 1000 }}>
        <div ref={menuRef} style={{ position: 'relative' }}>
          <button
            className="admin-menu-btn"
            onClick={() => setShowAdminMenu(!showAdminMenu)}
            style={{
              padding: '8px 16px',
              background: 'var(--accent-2)',
              color: 'var(--bg)',
              border: 'none',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: '500',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
          >
            Admin
            <span style={{ fontSize: '10px' }}>▼</span>
          </button>
          {showAdminMenu && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: '8px',
                background: '#1a1a17',
                border: '1px solid #2a2a28',
                borderRadius: '8px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                minWidth: '200px',
                zIndex: 1000,
                overflow: 'hidden'
              }}
            >
                <Link href="/admin/entities" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: '#e6e3dc',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid #2a2a28'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = '#2a2a28'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Entity Management
                  </div>
                </Link>
                <Link href="/admin/sources" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: '#e6e3dc',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid #2a2a28'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = '#2a2a28'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Data Sources
                  </div>
                </Link>
                <Link href="/admin/attributes" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: '#e6e3dc',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid #2a2a28'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = '#2a2a28'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Attributes
                  </div>
                </Link>
                <Link href="/admin/templates" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: '#e6e3dc',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid #2a2a28'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = '#2a2a28'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Templates
                  </div>
                </Link>
                <Link href="/admin/dq-rules" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: '#e6e3dc',
                    textDecoration: 'none',
                    fontSize: '14px'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = '#2a2a28'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    DQ Rules
                  </div>
                </Link>
              </div>
          )}
        </div>
        <div className="status-pill">
          <span className="status-dot"></span>All systems healthy
        </div>
        <div className="user-chip">
          <div style={{ fontSize: '11px', color: '#cbcac4' }}>Bill Reagan</div>
          <div className="avatar">BR</div>
        </div>
      </div>
    </div>
  );
}