'use client';

import { useTemporalStore } from '@/lib/store';
import Image from 'next/image';
import Link from 'next/link';
import { useState, useRef, useEffect, useCallback } from 'react';
import { AsOfDatePicker } from './AsOfDatePicker';
import { UserMenu } from './UserMenu';
import { BrandLogo } from './BrandLogo';

export function TopBar() {
  const { persona, setPersona, chatOpen, toggleChat } = useTemporalStore();
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
            <BrandLogo />
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
        <button
          className={`chat-launcher ${chatOpen ? 'active' : ''}`}
          onClick={toggleChat}
          aria-label={chatOpen ? 'Close assistant' : 'Open assistant'}
          aria-expanded={chatOpen}
          title={chatOpen ? 'Close assistant' : 'Open assistant'}
        >
          <Image
            className="chat-launcher-avatar"
            src="/tapestraichat-icon.png"
            alt=""
            width={26}
            height={26}
            unoptimized
          />
          <span className="chat-launcher-label">Chat</span>
        </button>
        <AsOfDatePicker />
        <div ref={menuRef} style={{ position: 'relative' }}>
          <button
            className="admin-menu-btn"
            onClick={() => setShowAdminMenu(!showAdminMenu)}
            style={{
              padding: '8px 16px',
              background: 'var(--brand-gradient)',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
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
                background: 'var(--surface)',
                border: '1px solid var(--line)',
                borderRadius: '10px',
                boxShadow: '0 12px 32px rgba(10, 22, 40, 0.14)',
                minWidth: '200px',
                zIndex: 1000,
                overflow: 'hidden'
              }}
            >
                <Link href="/admin/entities" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: 'var(--ink-2)',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid var(--line)'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-alt)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Entity Management
                  </div>
                </Link>
                <Link href="/admin/sources" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: 'var(--ink-2)',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid var(--line)'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-alt)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Data Sources
                  </div>
                </Link>
                <Link href="/admin/attributes" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: 'var(--ink-2)',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid var(--line)'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-alt)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Attributes
                  </div>
                </Link>
                <Link href="/admin/templates/studio" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: 'var(--ink-2)',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid var(--line)'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-alt)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Statement Studio
                  </div>
                </Link>
                <Link href="/admin/templates" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: 'var(--ink-2)',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid var(--line)'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-alt)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Templates
                  </div>
                </Link>
                <Link href="/admin/dq-rules" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: 'var(--ink-2)',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid var(--line)'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-alt)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    DQ Rules
                  </div>
                </Link>
                <Link href="/admin/compliance" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: 'var(--ink-2)',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid var(--line)'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-alt)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Compliance Rules
                  </div>
                </Link>
                <Link href="/admin/dashboards" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: 'var(--ink-2)',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid var(--line)'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-alt)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Dashboards
                  </div>
                </Link>
                <Link href="/admin/narratives" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: 'var(--ink-2)',
                    textDecoration: 'none',
                    fontSize: '14px',
                    borderBottom: '1px solid var(--line)'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-alt)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Narratives
                  </div>
                </Link>
                <Link href="/admin/tenancy" onClick={() => setShowAdminMenu(false)}>
                  <div style={{
                    padding: '12px 16px',
                    color: 'var(--ink-2)',
                    textDecoration: 'none',
                    fontSize: '14px'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-alt)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    Clients, Users &amp; Roles
                  </div>
                </Link>
              </div>
          )}
        </div>
        <div className="status-pill">
          <span className="status-dot"></span>All systems healthy
        </div>
        <UserMenu />
      </div>
    </div>
  );
}