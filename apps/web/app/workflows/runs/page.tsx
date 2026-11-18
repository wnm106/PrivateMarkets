import { redirect } from 'next/navigation';

// The breadcrumb links "Runs" here from a run page. Runs are listed on the workflows page.
export default function WorkflowRunsIndexPage() {
  redirect('/workflows');
}
