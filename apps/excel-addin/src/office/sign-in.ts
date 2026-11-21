import { parseExcelSessionMessage } from '@tapestrai/graphql/src/lib/excel-session';
import type { ExcelAuth } from '../lib/auth';

/**
 * Sign in with Office's dialog. The dialog opens the web app's /excel/connect page,
 * where the person signs in with their own account. The page sends back a session
 * made for Excel alone (docs/EXCEL_ADDIN.md). Only a message from this add-in's own
 * origin is accepted.
 */

const DIALOG_ERRORS: Record<number, string> = {
  12004: 'The sign-in page is not on a trusted domain.',
  12005: 'The sign-in page must use https.',
  12007: 'A sign-in window is already open.',
  12009: 'The sign-in window was blocked. Allow pop-ups for Excel and try again.',
  12011: 'Your browser settings blocked the sign-in window.',
};

export function connectUrl(origin: string = window.location.origin): string {
  return `${origin}/excel/connect`;
}

export function signInWithDialog(auth: ExcelAuth): Promise<{ ok: true } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { ok: true } | { ok: false; message: string }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    Office.context.ui.displayDialogAsync(connectUrl(), { height: 70, width: 35, promptBeforeOpen: false }, (result) => {
      if (result.status !== Office.AsyncResultStatus.Succeeded) {
        finish({ ok: false, message: DIALOG_ERRORS[result.error.code] || result.error.message || 'The sign-in window could not open.' });
        return;
      }
      const dialog = result.value;
      dialog.addEventHandler(Office.EventType.DialogMessageReceived, (arg) => {
        const message = arg as { message?: string | boolean; origin?: string };
        if (message.origin && message.origin !== window.location.origin) return;
        const session = parseExcelSessionMessage(typeof message.message === 'string' ? message.message : null);
        if (!session) return;
        auth.accept(session);
        dialog.close();
        finish({ ok: true });
      });
      dialog.addEventHandler(Office.EventType.DialogEventReceived, (arg) => {
        const code = (arg as { error?: number }).error;
        finish({ ok: false, message: code === 12006 ? 'Sign-in was closed before it finished.' : DIALOG_ERRORS[code || 0] || 'Sign-in stopped.' });
      });
    });
  });
}
