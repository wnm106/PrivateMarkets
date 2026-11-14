import { redirect } from 'next/navigation';

/** Every file now goes through one queue. The data specialist's questions appear on the review screen. */
export default function LoadPage() {
  redirect('/imports');
}
