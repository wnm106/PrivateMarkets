/**
 * How each step of the NAV review works, in the words the page shows under
 * "How this step works" and the assistant reads with each tab. One text, so the
 * page and the assistant explain a step the same way. The figures in it are the
 * reconciliation's own constants, never typed again here.
 */

import {
  DRIFT_FLOOR, MARK_TOLERANCE_PTS, MGMT_FEE_TOLERANCE, PERF_FEE_FLOOR, SOURCE_TOLERANCE_PCT, TIE,
} from '@tapestrai/graphql/src/lib/fund-rec';

export type RecGuideKey = 'close' | 'breaks' | 'pack' | 'stmt' | 'roll' | 'cash' | 'integrity' | 'fees' | 'val' | 'drift' | 'inputs';

export interface RecGuide {
  /** What the step establishes, in one sentence. */
  summary: string;
  /** A term or a question, and its answer. */
  points: Array<[term: string, text: string]>;
}

const dollars = (value: number) => `$${value.toLocaleString('en-US')}`;
const tie = dollars(TIE);

export const REC_GUIDE: Record<RecGuideKey, RecGuide> = {
  close: {
    summary: 'The steps between receiving the administrator\'s pack and certifying the NAV, in the order they are worked.',
    points: [
      ['Status', 'Each step sets its own status from the data: Not started, In progress, Blocked or Done. Only Reviewer sign-off is set by hand. The line under each step says what makes it done.'],
      ['Due dates', 'Each step is due a set share of the fund\'s certification lag after the period end. A step not done by its date is marked Overdue, and the close then shows as at risk.'],
      ['What holds certification', 'A check that breaks, a roll-forward line that does not tie, a query open with the administrator, or a review item with no decision. The box at the top right names the first of these. Breaks lists all of them.'],
      ['Review queue', 'Accept takes the administrator\'s figure. Adjust keeps ours: the item\'s NAV effect is added to the proposed NAV. Query admin sends the item back and holds certification until it is accepted or adjusted. Press the same decision again to clear it.'],
      ['Cash reconciliation', 'Worked beside the steps. It does not hold certification; whether cash ties, and what is still open, is recorded with the certification.'],
      ['Certifying', 'Certify NAV records the figures on screen at that moment. A certified close keeps showing what was certified. To change it, reopen it with a reason.'],
      ['Where a figure comes from', 'Right-click any figure for the records it was read from.'],
    ],
  },
  breaks: {
    summary: 'Everything between this period and certification in one list, each with its two figures, the usual cause, the next step and the owner.',
    points: [
      ['Breaks', `Two figures that must agree are further apart than the check allows (${tie} for most checks), or a line of the position roll-forward does not tie. Each holds certification.`],
      ['Open review items', 'A fee, mark, accrual or drift item that is not yet accepted or adjusted. Each holds certification, including one queried with the administrator.'],
      ['Checks with a figure missing', 'A check that cannot be made until a figure is on file. It is a gap, not a break, and does not hold certification.'],
      ['Not on file', 'An input or a part of the NAV pack that is not loaded. Only a part the fund marks as required holds certification.'],
      ['Working an entry', 'The title opens the tab where the entry is worked. Review items are decided in the review queue on the right.'],
    ],
  },
  pack: {
    summary: 'What the administrator\'s pack should hold for this fund, what is on file, and whether each part agrees with the statements and with the other parts.',
    points: [
      ['Status', 'Ties: on file and every check agrees. Breaks: a check disagrees. Open: a review item on it is undecided. Partial: on file, with a figure or the notes missing. Not on file: the fund\'s pack should hold it and it does not. Not expected: the fund\'s terms do not call for it.'],
      ['Required', 'A part the fund record lists as required. A required part that is missing or breaks holds certification.'],
      ['Pack checks', `The checks each part adds are listed at the foot of the tab and on Statement integrity. Most dollar figures tie within ${tie}; an investor\'s capital account is held tighter.`],
      ['When a part is missing', 'Ask the administrator for it and load it in Load data. Breaks names who asks.'],
    ],
  },
  stmt: {
    summary: 'The administrator\'s statements line by line, beside our own figures and the prior period.',
    points: [
      ['Variance', `Fund admin less Internal, where both are on file. A line is marked Source variance when the two differ by more than ${SOURCE_TOLERANCE_PCT}%, or the tolerance set on the statement.`],
      ['Prior and Change', `The same line at the date the period is compared with. A line is marked Unexplained drift when it moved more than the drift threshold, by at least ${dollars(DRIFT_FLOOR)}, and no flow in the pack explains it. It then goes to the review queue.`],
      ['What it holds', 'Nothing by itself. Figures that must agree are checked on Statement integrity, and drift is decided in the review queue.'],
      ['Units', 'Dollars in millions, except lines that are a share count or dollars a share.'],
    ],
  },
  roll: {
    summary: 'Proves the move in the portfolio position by position: opening value plus the period\'s cash flows and P&L must reach the ending value, and each total must agree with the administrator\'s statements.',
    points: [
      ['The walk', 'Beginning value + Purchases + Repayments and sales + Interest and fees received + Total P&L = Ending value. Value is fair value plus accrued interest. Cash that comes back to the fund reduces the position, so repayments, sales and interest received are negative.'],
      ['Reported ending and Difference', 'Reported ending is the fair value and accrued interest each position reports at the period end. Difference is reported ending less the walk. It should be zero for every position.'],
      ['Per statements', 'The same totals read from the administrator\'s statements: investments and interest receivable from the balance sheet, purchases and proceeds from the cash flow statement, income and gains from the statement of operations.'],
      ['Ties and breaks', `A line ties when the roll-forward is within ${tie} of the statement. "No statement line" means the statement has no figure to compare; that does not hold the close.`],
      ['What it holds', 'Any line that breaks blocks this step and certification, and is listed on Breaks.'],
      ['Where the rows come from', 'Each position\'s cash flows for the period (purchases, repayments, sales, interest, fees and PIK), rolled into their buckets, and its opening value at the prior period end. A position\'s name opens its record; right-click a figure for the records behind it.'],
      ['When it does not tie', 'Find the position whose Difference is not zero, or the column where Total fund and Per statements disagree, then load or correct the cash flow that explains it.'],
    ],
  },
  cash: {
    summary: 'Agrees the fund\'s position cash flows with its bank transactions for the period, one pair at a time.',
    points: [
      ['How to work it', '1. The match rules propose pairs: approve them in the review tray. 2. Pair what is left by hand: select a bank transaction, tick the cash flows that settle it, and press Pair. 3. Explain what remains with an adjustment that says why. The period is tied when position book less bank is zero.'],
      ['What is in the period', 'Position cash flows dated in the period, and bank transactions dated in the period or within a few business days after it, so a late settlement can be paired. PIK, amortization and realized or unrealized gains are not cash: they stay on the roll-forward.'],
      ['Signs', 'Money leaving the fund is negative on both sides.'],
      ['Statuses', 'Open has no pair. Proposed was paired by a rule and waits for approval. Approved is settled; Unmatch releases it.'],
      ['Match rules', 'Run top to bottom, and the first rule that fits a bank transaction wins. A looser rule gives a lower confidence. Turning a rule off or moving it changes what is proposed; approved pairs stay.'],
      ['Tie-out', 'Position book cash plus its adjustments, against bank activity plus its adjustments. Pairing does not change the totals: it shows which items explain them. Tied means the two are within a cent.'],
      ['Adjustments', 'Post one only for a difference whose cause is known. Bank side: an item the bank has not shown yet, such as a deposit in transit. Position book side: cash the bank shows that is missing from our book, such as a bank fee. Each needs a reason and is kept as a record; its name opens it.'],
      ['What it holds', 'Nothing. Cash reconciliation does not block certification. Closing cash against the bank statement balance is a separate check on Statement integrity, and that one does.'],
    ],
  },
  integrity: {
    summary: 'Every figure that must agree with another: the statements with each other, with our position book, with outside evidence and with the NAV pack.',
    points: [
      ['A and B', 'The two figures a check compares. Compared says where they come from. Difference is A less B.'],
      ['Ties', `The two are within the check\'s tolerance: ${tie} for most, wider for investments against the position book and the schedule of investments.`],
      ['Break', 'The two are further apart than that. Every break holds certification.'],
      ['Evidence missing', 'One of the figures is not on file, so the check cannot be made. It does not hold certification; Rec inputs says what to load.'],
      ['When a check breaks', 'Breaks lists it with its usual cause, the next step and the owner.'],
    ],
  },
  fees: {
    summary: 'Recalculates the management fee and the performance or incentive fee from the fund\'s terms, and compares each with what the administrator charged.',
    points: [
      ['Management fee', `The fund\'s rate on its fee base for the share of a year the period covers. A difference over ${(MGMT_FEE_TOLERANCE * 100).toFixed(1)}% of the recalculated fee goes to the review queue.`],
      ['Performance or incentive fee', `An estimate for reasonableness from the fund\'s preferred return, carry and catch-up. The administrator\'s calculation governs. A difference over ${dollars(PERF_FEE_FLOOR)} goes to the review queue.`],
      ['Terms', 'Rates and bases are read from the fund record. A term that is missing shows on Rec inputs.'],
      ['What it holds', 'A fee item holds certification until it is accepted or adjusted in the review queue.'],
    ],
  },
  val: {
    summary: 'Compares the administrator\'s marks and interest accrual with ours, and shows what each difference is worth in NAV.',
    points: [
      ['Position marks', `Administrator mark against the valuation agent\'s price. A difference over ${MARK_TOLERANCE_PTS} point is marked Review and goes to the review queue, with its NAV effect at the agent\'s price.`],
      ['Accrual spot check', `Administrator interest receivable against our loan-level accrual, position by position. A fund-level difference of ${tie} or more goes to the review queue.`],
      ['What it holds', 'A mark or accrual item holds certification until it is accepted or adjusted in the review queue.'],
    ],
  },
  drift: {
    summary: 'How each statement line and key ratio moved since the prior period, and which large moves nothing explains.',
    points: [
      ['Explained by', 'The flow in the pack that accounts for the move, when one does. "Within threshold" means the move is too small to need one.'],
      ['Unexplained', `A move over the threshold, of at least ${dollars(DRIFT_FLOOR)} for a dollar line, with no flow that explains it. It goes to the review queue.`],
      ['Threshold', 'Set at the top of the tab for this view. Changing it changes which lines are flagged, and so what is in the review queue.'],
      ['What it holds', 'A drift item holds certification until it is accepted or adjusted in the review queue.'],
    ],
  },
  inputs: {
    summary: 'What the reconciliation reads for the period, and whether each input is on file.',
    points: [
      ['On file', 'The input is loaded for the period. The middle column says what was found.'],
      ['Missing', 'A required input that is not loaded. The checks that need it show as missing, and the close cannot be worked in full until it is.'],
      ['Not needed', 'The fund\'s terms do not call for it, such as a lender statement for a fund with no credit facility.'],
      ['Getting an input on file', 'Load the file in Load data, or let its feed bring it. Fee and waterfall terms are set on the fund record.'],
    ],
  },
};

/** The guide as one paragraph, for the assistant's reading notes on a tab. */
export function guideText(key: RecGuideKey): string {
  const guide = REC_GUIDE[key];
  return `${guide.summary} ${guide.points.map(([term, text]) => `${term}: ${text}`).join(' ')}`;
}
