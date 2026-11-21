import type { Metadata } from 'next';
import { ExcelConnect } from '@/components/excel/ExcelConnect';

export const metadata: Metadata = {
  title: 'Connect Excel - tapestr.ai',
};

/** Signs a person in for the Excel add-in. See components/excel/ExcelConnect.tsx. */
export default function ExcelConnectPage() {
  return <ExcelConnect />;
}
