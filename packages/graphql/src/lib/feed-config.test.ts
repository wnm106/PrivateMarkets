import { describe, expect, it } from 'vitest';
import { cleanConnectionConfig, cleanFeedPath, cleanFolder, cleanRemoteFolder, cleanSender, codeFrom, needsSecret } from './feed-config';

describe('cleanFolder', () => {
  it('tidies a folder path and refuses anything that could leave it', () => {
    expect(cleanFolder(' /admin//nav/ ')).toBe('admin/nav');
    expect(cleanFolder('')).toBe('');
    expect(() => cleanFolder('../other')).toThrow(/may only use/);
    expect(() => cleanFolder('nav/*.csv')).toThrow(/may only use/);
  });
});

describe('cleanConnectionConfig', () => {
  it('keeps only the folder for a storage connection', () => {
    expect(cleanConnectionConfig('STORAGE', { folder: 'admin', password: 'oops' })).toEqual({ folder: 'admin' });
  });

  it('keeps only known settings for an http connection, so a stray credential is dropped', () => {
    expect(cleanConnectionConfig('HTTP', { baseUrl: 'https://files.example.com/packs', authType: 'bearer', token: 'secret', headerName: 'X' })).toEqual({
      baseUrl: 'https://files.example.com/packs',
      authType: 'BEARER',
    });
    expect(cleanConnectionConfig('HTTP', { baseUrl: 'https://files.example.com/', authType: 'BASIC', username: ' ops ' })).toMatchObject({ username: 'ops' });
    expect(cleanConnectionConfig('HTTP', { baseUrl: 'https://files.example.com/', authType: 'HEADER', headerName: 'X-Api-Key' })).toMatchObject({ headerName: 'X-Api-Key' });
  });

  it('refuses http, a credential in the address, and missing sign-in details', () => {
    expect(() => cleanConnectionConfig('HTTP', { baseUrl: 'http://files.example.com/' })).toThrow(/https/);
    expect(() => cleanConnectionConfig('HTTP', { baseUrl: 'https://ops:pw@files.example.com/' })).toThrow(/credential box/);
    expect(() => cleanConnectionConfig('HTTP', { baseUrl: 'not an address' })).toThrow(/starting with https/);
    expect(() => cleanConnectionConfig('HTTP', { baseUrl: 'https://files.example.com/', authType: 'BASIC' })).toThrow(/user name/);
    expect(() => cleanConnectionConfig('HTTP', { baseUrl: 'https://files.example.com/', authType: 'HEADER', headerName: 'bad header' })).toThrow(/header/);
    expect(() => cleanConnectionConfig('FTP', {})).toThrow(/STORAGE, HTTP, SFTP, or EMAIL/);
  });
});

describe('sftp settings', () => {
  const good = { host: 'SFTP.Example.com', username: 'feeds', folder: '/outbound/nav', password: 'oops' };

  it('keeps known settings, fills defaults, and drops a stray credential', () => {
    expect(cleanConnectionConfig('SFTP', good)).toEqual({
      host: 'sftp.example.com', port: 22, username: 'feeds', authType: 'PASSWORD', folder: '/outbound/nav', afterLoad: 'MOVE',
    });
    expect(cleanConnectionConfig('SFTP', { ...good, port: '2222', authType: 'key', afterLoad: 'leave', hostKey: `SHA256:${'A'.repeat(43)}` })).toMatchObject({
      port: 2222, authType: 'KEY', afterLoad: 'LEAVE', hostKey: `SHA256:${'A'.repeat(43)}`,
    });
  });

  it('refuses a host with a scheme or path, a bad port, a missing user and a malformed host key', () => {
    expect(() => cleanConnectionConfig('SFTP', { ...good, host: 'sftp://sftp.example.com' })).toThrow(/server name only/);
    expect(() => cleanConnectionConfig('SFTP', { ...good, host: 'sftp.example.com/outbound' })).toThrow(/server name only/);
    expect(() => cleanConnectionConfig('SFTP', { ...good, host: 'user@sftp.example.com' })).toThrow(/server name only/);
    expect(() => cleanConnectionConfig('SFTP', { ...good, port: 70000 })).toThrow(/port/);
    expect(() => cleanConnectionConfig('SFTP', { ...good, username: ' ' })).toThrow(/user name/);
    expect(() => cleanConnectionConfig('SFTP', { ...good, hostKey: 'MD5:aa:bb' })).toThrow(/host key/);
    expect(() => cleanConnectionConfig('SFTP', { ...good, folder: '/outbound/../etc' })).toThrow(/may only use/);
  });

  it('keeps a leading slash on a server folder and always needs a credential', () => {
    expect(cleanRemoteFolder('/outbound/nav/')).toBe('/outbound/nav');
    expect(cleanRemoteFolder('outbound')).toBe('outbound');
    expect(cleanRemoteFolder('')).toBe('');
    expect(needsSecret('SFTP', {})).toBe(true);
    expect(cleanFeedPath('SFTP', 'nav/')).toBe('nav');
  });
});

describe('needsSecret, cleanFeedPath, codeFrom', () => {
  it('needs a credential only for http with a sign-in', () => {
    expect(needsSecret('HTTP', { authType: 'BEARER' })).toBe(true);
    expect(needsSecret('HTTP', { authType: 'NONE' })).toBe(false);
    expect(needsSecret('STORAGE', {})).toBe(false);
  });

  it('keeps an http path relative so it cannot point at another host', () => {
    expect(cleanFeedPath('HTTP', 'nav/{YYYY}{MM}{DD}.csv')).toBe('nav/{YYYY}{MM}{DD}.csv');
    expect(() => cleanFeedPath('HTTP', 'https://elsewhere.example.com/x')).toThrow(/only the part/);
    expect(() => cleanFeedPath('HTTP', '//elsewhere.example.com/x')).toThrow(/only the part/);
    expect(() => cleanFeedPath('HTTP', '\\\\elsewhere.example.com\\x')).toThrow(/only the part/);
    expect(cleanFeedPath('STORAGE', '/nav/')).toBe('nav');
    expect(() => cleanFeedPath('STORAGE', '../x')).toThrow(/subfolder/);
  });

  it('makes a code from a name', () => {
    expect(codeFrom('Administrator NAV pack (monthly)', 'FEED')).toBe('ADMINISTRATOR_NAV_PACK_MONTHLY');
    expect(codeFrom('  ', 'FEED')).toBe('FEED');
  });
});

describe('email connections', () => {
  it('keeps allowed senders, file types and limits, and drops anything else', () => {
    expect(
      cleanConnectionConfig('EMAIL', {
        allowedSenders: ' Ops@AdminCo.com, @fundadmin.co.uk\nops@adminco.com ',
        fileTypes: ['XLSX', '.csv'],
        maxPerHour: '10',
        password: 'oops',
      }),
    ).toEqual({
      allowedSenders: ['ops@adminco.com', 'fundadmin.co.uk'],
      requireDkim: true,
      fileTypes: ['xlsx', 'csv'],
      maxPerHour: 10,
      maxMessageMb: 25,
    });
  });

  it('needs a sender, and refuses what is not an address or a domain', () => {
    expect(() => cleanConnectionConfig('EMAIL', { allowedSenders: '' })).toThrow(/at least one sender/);
    expect(() => cleanConnectionConfig('EMAIL', { allowedSenders: 'adminco' })).toThrow(/not an email address or a domain/);
    expect(() => cleanConnectionConfig('EMAIL', { allowedSenders: '*@adminco.com' })).toThrow(/not an email address/);
  });

  it('never takes file types outside the safe list', () => {
    expect(() => cleanConnectionConfig('EMAIL', { allowedSenders: 'adminco.com', fileTypes: ['xlsm'] })).toThrow(/cannot be taken/);
    expect(() => cleanConnectionConfig('EMAIL', { allowedSenders: 'adminco.com', fileTypes: ['zip'] })).toThrow(/cannot be taken/);
  });

  it('turns the DKIM requirement off only when asked', () => {
    expect(cleanConnectionConfig('EMAIL', { allowedSenders: 'adminco.com', requireDkim: false }).requireDkim).toBe(false);
    expect(cleanConnectionConfig('EMAIL', { allowedSenders: 'adminco.com', requireDkim: 'yes' }).requireDkim).toBe(true);
  });

  it('keeps limits in range', () => {
    expect(() => cleanConnectionConfig('EMAIL', { allowedSenders: 'adminco.com', maxPerHour: 0 })).toThrow(/between 1 and 500/);
    expect(() => cleanConnectionConfig('EMAIL', { allowedSenders: 'adminco.com', maxMessageMb: 100 })).toThrow(/between 1 and 35/);
  });

  it('cleans one sender', () => {
    expect(cleanSender('@AdminCo.com')).toBe('adminco.com');
    expect(cleanSender('a.b+nav@x.io')).toBe('a.b+nav@x.io');
    expect(cleanSender('x@localhost')).toBeNull();
  });

  it('has no path, needs no credential, and keeps drop folders out of the email folder', () => {
    expect(cleanFeedPath('EMAIL', 'anything')).toBe('');
    expect(needsSecret('EMAIL', {})).toBe(false);
    expect(() => cleanConnectionConfig('STORAGE', { folder: '_email/x' })).toThrow(/cannot start with _email/);
  });
});
