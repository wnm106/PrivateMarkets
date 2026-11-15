import { describe, expect, it } from 'vitest';
import { cleanConnectionConfig, cleanFeedPath, cleanFolder, codeFrom, needsSecret } from './feed-config';

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
    expect(() => cleanConnectionConfig('SFTP', {})).toThrow(/STORAGE or HTTP/);
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
