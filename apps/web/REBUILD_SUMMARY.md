# Meridian MDM Frontend Rebuild Summary

## Overview
Complete frontend rebuild to match the HTML mockup design specification. The application now uses an editorial, high-density financial design language with IBM Plex fonts and a warm color palette.

## Design System

### Color Palette
- **Background**: `#f7f6f3` (warm off-white)
- **Surface**: `#ffffff`
- **Ink colors**: `#0a0a0a`, `#2a2a28`, `#5a5a55`, `#9a9a93`
- **Accent**: `#b8531a` (burnt sienna)
- **Accent-2**: `#1b3a4b` (deep teal)
- **Semantic**: Gold `#c89c3f`, Green `#2f7d4f`, Red `#b53030`, Amber `#c98a0c`

### Source Colors
- Bloomberg: `#c2410c`
- WSO: `#6d28d9`
- DealCloud: `#0369a1`
- Allvue: `#047857`
- S&P Capital IQ: `#be185d`
- Manual: `#b45309`
- Derived: `#475569`

### Typography
- **Body**: IBM Plex Sans
- **Headlines/Titles/Numbers**: IBM Plex Serif
- **Data/Code**: IBM Plex Mono

## Layout Structure

### Removed
- ❌ Sidebar navigation (not in design)
- ❌ Generic Tailwind cards with emoji icons
- ❌ Old placeholder pages (dq-exceptions, positions, prices)

### New Layout Components
- ✅ **TopBar** (`components/layout/TopBar.tsx`)
  - Dark background (`#0a0a0a`)
  - Brand mark (sienna square with "M")
  - "Meridian" in serif font
  - Role tabs (Data Steward / Operations Analyst / Governance Lead)
  - Status pill with green dot
  - User chip with avatar

- ✅ **SourceLegend** (`components/layout/SourceLegend.tsx`)
  - White bar below topbar
  - Colored swatches for each source
  - Last sync timestamp

## Pages Implemented (7 Views)

### 1. Landing/Dashboard (`app/page.tsx`)
- Hero section with burnt sienna eyebrow "Master Data Management"
- Serif title "One *source of truth*, across every system."
- Search box with ⌘K shortcut
- Stat strip: 4 metrics (Total Records, Avg Data Quality, Open Exceptions, Sources Connected)
- Entity domain cards: 5 cards (Funds, Issuers, Securities, Deals, Investors)
  - Serif letter icon (F, I, S, D, V) with domain-specific color
  - Record count, description, source tags
  - Quality percentage with trend arrow
  - Steward count
- Cross-cutting tools nav: Precedence Rules, Data Quality Framework, Standardized Value Lists

### 2. Entity List (`app/securities/page.tsx`)
- Breadcrumb navigation
- Page header with colored accent bar
- Filter bar with pill-style filters
- Data table with columns: ID (mono), Name, Type (chip), Issuer, Ccy, Notional, Primary Source (badge), Conflicts, Quality
- Source badges colored per source

### 3. Record Detail (`app/securities/[id]/page.tsx`)
- Record header with ID, status chips, quality score
- Field sections with expandable drill-down
- Each field row has: source color left border, field label, value, source badge
- **Field drill-down**: Shows all source candidates with values, dates, reliability bars, status pills
- Right rail with 3 cards:
  - Source Contribution (bar chart)
  - Active Conflicts (alert card)
  - Activity feed

### 4. Precedence Rules (`app/precedence/page.tsx`)
- Rule tabs by domain
- Rule cards with field name, condition (monospace with keywords highlighted), source chain
- "New Rule" button

### 5. Data Quality Framework (`app/quality/page.tsx`)
- 3 pillar cards (Availability, Quality, Trajectory)
- Quality matrix table with bar charts, trend arrows, sparklines
- Bottom grid: Top Exception Rules + Source Reliability scores

### 6. Standardized Value Lists (`app/lists/page.tsx`)
- Grid of vocabulary cards
- Canonical values, mapped counts, source tags

### 7. Conflict Resolution (`app/resolve/page.tsx`)
- Red-accented header with progress steps
- Conflict cards with candidate grid (4 columns)
- Custom value input section
- Summary sidebar with impact calculation
- Audit note textarea

### Bonus: Rule Builder (`app/precedence/new/page.tsx`)
- 4-step wizard: Scope, Conditions, Precedence Chain, Normalization
- Live preview with pseudo-code
- Test against real records

## Data Layer

### `lib/data.ts`
Complete data module with:
- Source definitions (7 sources with colors)
- Entity definitions (5 domains)
- Securities records (8 sample records)
- Golden record structure (5 sections, 22 fields)
- Field candidates for drill-down (6 detailed examples)
- Precedence rules (7 rules)
- Quality matrix (5 entities)
- Standardized lists (9 vocabularies)
- Top exceptions (5 rules)
- Source reliability scores (6 sources)
- Helper functions: `qualityColor()`, `fmtDollar()`, `daysAgo()`

### `lib/store.ts` (Preserved)
Zustand store for temporal state and persona switching

## Styling

### `tailwind.config.js`
Complete design token system:
- Custom colors matching CSS variables
- Font families for IBM Plex variants
- Custom font sizes (xxs to 4xl)
- Letter spacing utilities

### `styles/globals.css`
Comprehensive custom CSS for:
- Editorial typography
- Complex component styles (drill-downs, rule cards, conflict resolution)
- Animations (view fade, drill-down open)
- Source badges and color coding
- Quality indicators and trend arrows

## Key Interactions

1. **Field rows are expandable** - Click to show lineage drill-down
2. **Entity cards are clickable** - Navigate to entity list
3. **Role tabs switch persona** - Updates global state
4. **Breadcrumb navigation** - Between all views
5. **Candidate selection** - In conflict resolution

## Files to Clean Up

Run these commands to remove old placeholder files:

```powershell
cd "C:\Users\billm\Private Markets\meridian-mdm\apps\web"
Remove-Item -Path "app\dq-exceptions\page.tsx" -Force
Remove-Item -Path "app\positions\page.tsx" -Force
Remove-Item -Path "app\prices\page.tsx" -Force
Remove-Item -Path "components\domains\FundList.tsx" -Force
```

## Next Steps

1. Run cleanup commands above
2. Start dev server: `npm run dev`
3. Test all 7 views
4. Verify field drill-down interactions
5. Test conflict resolution flow
6. Check responsive behavior (if needed)

## Design Fidelity

The rebuild faithfully reproduces:
- ✅ Exact color palette from HTML mockup
- ✅ Editorial typography with IBM Plex fonts
- ✅ High-density financial dashboard aesthetic
- ✅ No emoji icons (uses serif letter glyphs and SVG icons)
- ✅ Source color coding throughout
- ✅ Complex interactions (drill-downs, conflict resolution)
- ✅ All 7 page views from mockup
- ✅ Realistic financial data
