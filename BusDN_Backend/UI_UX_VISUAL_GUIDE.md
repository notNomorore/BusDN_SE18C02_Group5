# Visual UI/UX Guide - Bus Route Detail Feature

## User Journey Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER JOURNEY MAP                         │
└─────────────────────────────────────────────────────────────────┘

                   ┌──────────────────┐
                   │   LOAD PAGE      │
                   │  (Initialization)│
                   └────────┬─────────┘
                            ↓
              ┌─────────────────────────────────┐
              │  SEARCH VIEW DISPLAYED          │
              │  • Header: "🚌 Tra Cứu Tuyến"  │
              │  • Input: Search box            │
              │  • Output: Empty state          │
              └────────────┬────────────────────┘
                           ↓
              (User types route number or name)
                           ↓
              ┌─────────────────────────────────┐
              │  SEARCH RESULTS LOADED          │
              │  • Loading spinner              │
              │  • Route list populated         │
              │  • Each route clickable         │
              └────────────┬────────────────────┘
                           ↓
              (User clicks on a route)
                           ↓
    ┌──────────────────────────────────────────────────────┐
    │            DETAIL VIEW DISPLAYED                     │
    │  ┌────────────────────────────────────────────────┐  │
    │  │ SIDEBAR 35%                    MAP 65%         │  │
    │  │                                                 │  │
    │  │ ┌──────────────────────┐     ┌─────────────┐  │  │
    │  │ │ DETAIL HEADER        │     │   LEAFLET   │  │  │
    │  │ │ Route #01            │     │    MAP      │  │  │
    │  │ │ Route Name           │     │             │  │  │
    │  │ │ [← Back Button]      │     │  🔴🔴🔴🟦🟦│  │  │
    │  │ └──────────────────────┘     │  ║║║║║║║║║║│  │  │
    │  │                               │  --════--  │  │  │
    │  │ ┌──────────────────────┐     │  🟢🔴🟦    │  │  │
    │  │ │ DIRECTION TOGGLE     │     │             │  │  │
    │  │ │ [📍 Lượt Đi][Lượt V]│     │ Info Panel:  │  │  │
    │  │ └──────────────────────┘     │ • Name      ├──┐  │
    │  │                               │ • Number    │ │  │
    │  │ ┌──────────────────────┐     │ • Distance  │ │  │
    │  │ │ SUB-TABS             │     │ • Hours     │ │  │
    │  │ │ [🚏][ℹ️][⭐]        │     │             │ │  │
    │  │ └──────────────────────┘     └─────────────┘ │  │
    │  │                                                 │  │
    │  │ ┌──────────────────────┐                       │  │
    │  │ │ TAB CONTENT          │                       │  │
    │  │ │ (Dynamic based on    │                       │  │
    │  │ │  selected tab)       │                       │  │
    │  │ └──────────────────────┘                       │  │
    │  └────────────────────────────────────────────────┘  │
    └──────────────────────────────────────────────────────┘

                        ↙      ↓       ↘
          ┌─────────────┴──┬────┴─────┬──────────────┐
          ↓                ↓          ↓              ↓
    [Direction      [Tab 1: Stops] [Tab 2: Info] [Tab 3: Reviews]
     Toggle]        ← Click to fly    → Info cards    → Rating + Form
                       to map
     ↓               ↓                ↓              ↓
   [Re-render]   [FlyTo Anim]    [Update Cards]  [Add Review]
   [Map + List]   [Popup]        [Change  Data]  [Show List]
          │                │          │              │
          └────────────────┴──────────┴──────────────┘
                           ↓
    (User clicks back button)
                           ↓
    ┌────────────────────────────────────────────────────┐
    │ SEARCH VIEW RESTORED                               │
    │ • List cleared (can start new search)              │
    │ • Map cleared                                      │
    └────────────────────────────────────────────────────┘
```

---

## Screen Layouts

### Layout 1: Search View (960x1080px Desktop)
```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│        🚌 TRA CỨU TUYẾN              ║│       MAP           │
│     Tìm tuyến xe và xem               ║│                    │
│     lộ trình trên bản đồ              ║│     (Leaflet)       │
│                                       ║│                    │
│  ┌───────────────────────────────┐   ║│   OpenStreetMap    │
│  │ Tìm kiếm tuyến xe             │   ║│                    │
│  │ ┌──────────────────────────────┐  ║│   [My Location]    │
│  │ │ Nhập số tuyến hoặc tên...   │  ║│     (zoom)         │
│  │ └──────────────────────────────┘  ║│   [+] [-] [⚙]     │
│  │ ┌──────────────────────────────┐  ║│                    │
│  │ │ 🔍 Tìm Kiếm                  │  ║│                    │
│  │ └──────────────────────────────┘  ║│                    │
│  └───────────────────────────────┘   ║│                    │
│                                       ║│   Info Panel:      │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ║│   • Tuyến: ---    │
│  DANH SÁCH TUYẾN                     ║│   • Số hiệu: ---  │
│  ┌───────────────────────────────┐   ║│   • Khoảng cách   │
│  │ 01                            │   ║│   • Thời gian     │
│  │ Hải Châu - Cẩm Lệ             │   ║│                    │
│  │ 05:00 - 23:00                 │   ║│   [📱 Muốn Đặt Vé]│
│  │                               │   ║│   Tải app...       │
│  │ 02                            │   ║│   [App][CHPlay]    │
│  │ Hòa Khánh - Liên Chiểu        │   ║│                    │
│  │ 05:30 - 23:30                 │   ║│                    │
│  │                               │   ║│                    │
│  │ 03                            │   ║│                    │
│  │ Sơn Trà - Ngũ Hành Sơn        │   ║│                    │
│  └───────────────────────────────┘   ║│                    │
│  Nhập từ khóa để tìm kiếm             ║│                    │
└──────────────────────────────────────────────────────────────┘
  35%                                   65%
```

---

### Layout 2: Detail View - Stops Tab
```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│    ← QUY LẠI                        ║│       MAP            │
│    Tuyến 01 - Hải Châu - Cẩm Lệ   ║│   with markers       │
│    Số hiệu: 01                        ║│   and polyline      │
│                                       ║│                    │
│  ┌─────────────────────────────────┐ ║│    🟢 (Green)      │
│  │ [📍 LƯỢT ĐI] [Lượt Về]          │ ║│      │             │
│  └─────────────────────────────────┘ ║│      ├─ 🟦 (Teal)  │
│                                       ║│      │             │
│  [🚏 TRẠM DỪNG] [ℹ️ THÔNG TIN] [⭐]│ ║│      └─ 🔴 (Red)  │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ║│                    │
│                                       ║│                    │
│  ┌─────────────────────────────────┐ ║│                    │
│  │━━━━━━━━━━━━━━━━━━━━━━━━━━━━     │ ║│ Info Panel:        │
│  │  🟢 1  Terminal Hải Châu         │ ║│ • Tuyến: 01       │
│  │         ⏱️ 05:00 📏 0 km         │ ║│ • Số hiệu: 01     │
│  │  │                               │ ║│ • Khoảng cách: 15.│
│  │  ├─  🟦 2  Phan Bội Châu         │ ║│ • Thời gian:      │
│  │  │         ⏱️ 05:08 📏 1.2 km   │ ║│   05:00-23:00     │
│  │  │                               │ ║│                    │
│  │  ├─  🟦 3  Chu Văn An            │ ║│                    │
│  │  │         ⏱️ 05:15 📏 2.5 km   │ ║│                    │
│  │  │                               │ ║│                    │
│  │  ├─  🟦 4  Hàn Mạc Tử            │ ║│                    │
│  │  │         ⏱️ 05:22 📏 4.1 km   │ ║│                    │
│  │  │                               │ ║│                    │
│  │  └─  🔴 5  Terminal Cẩm Lệ       │ ║│                    │
│  │         ⏱️ 05:30 📏 5.8 km      │ ║│                    │
│  │                                   │ ║│                    │
│  └─────────────────────────────────┘ ║│                    │
│  Scroll to see more stops             ║│                    │
└──────────────────────────────────────────────────────────────┘

Click any stop → map flies to it with smooth animation
Colored dots:  🟢 Start  |  🟦 Middle  |  🔴 End/Terminal
Vertical line connects all stops with gradient effect
```

---

### Layout 3: Detail View - Info Tab
```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│    ← QUY LẠI                        ║│       MAP            │
│    Tuyến 01 - Hải Châu - Cẩm Lệ   ║│                     │
│    Số hiệu: 01                        ║│    (No changes     │
│                                       ║│     in map)        │
│  ┌─────────────────────────────────┐ ║│                    │
│  │ [Lượt Đi] [Lượt Về]             │ ║│                    │
│  └─────────────────────────────────┘ ║│                    │
│                                       ║│                    │
│  [🚏] [ℹ️ THÔNG TIN] [⭐]           ║│                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ║│                    │
│                                       ║│                    │
│  ┌───────────────────┬───────────────┐║│                    │
│  │ MÃ TUYẾN          │ TÊN TUYẾN    │║│                    │
│  │ 01                │ Hải Châu -   │║│                    │
│  │                   │ Cẩm Lệ       │║│                    │
│  ├───────────────────┼───────────────┤║│                    │
│  │ KHOẢNG CÁCH       │ GIỜ HOẠT ĐỘNG│║│                    │
│  │ 15.5 km           │ 05:00-23:00  │║│                    │
│  ├───────────────────┼───────────────┤║│                    │
│  │ ĐIỂM ĐẦU          │ ĐIỂM CUỐI   │║│                    │
│  │ Terminal Hải Châu │ Terminal    │║│                    │
│  │                   │ Cẩm Lệ      │║│                    │
│  └───────────────────┴───────────────┘║│                    │
│                                       ║│                    │
│  (2-column grid, responsive to 1-col │║│                    │
│   on mobile)                          ║│                    │
│                                       ║│                    │
│                                       ║│                    │
└──────────────────────────────────────────────────────────────┘

Each card has:
┌─────────────────┐
│ MÃ TUYẾN        │ ← Label (uppercase, small)
│ 01              │ ← Value (bold, large)
│ │ (left border, teal color) 
└─────────────────┘
```

---

### Layout 4: Detail View - Reviews Tab
```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│    ← QUY LẠI                        ║│       MAP            │
│    Tuyến 01 - Hải Châu - Cẩm Lệ   ║│                     │
│    Số hiệu: 01                        ║│    (No changes)    │
│                                       ║│                    │
│  ┌─────────────────────────────────┐ ║│                    │
│  │ [Lượt Đi] [Lượt Về]             │ ║│                    │
│  └─────────────────────────────────┘ ║│                    │
│                                       ║│                    │
│  [🚏] [ℹ️] [⭐ ĐÁNH GIÁ]            ║│                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ║│                    │
│                                       ║│                    │
│  ┌─────────────────────────────────┐ ║│                    │
│  │                                 │ ║│                    │
│  │  Một sao:   ★☆☆☆☆              │ ║│                    │
│  │  (Click để chọn)                │ ║│                    │
│  │                                 │ ║│                    │
│  │  ┌───────────────────────────────┤ ║│                    │
│  │  │ Chia sẻ trải nghiệm của bạn..│ ║│                    │
│  │  │                               │ ║│                    │
│  │  │ Dòng 2                        │ ║│                    │
│  │  │ Dòng 3                        │ ║│                    │
│  │  │                               │ ║│                    │
│  │  └───────────────────────────────┘ ║│                    │
│  │ ┌─────────────────────────────────┐║│                    │
│  │ │ GỬI ĐÁNH GIÁ                   ││║│                    │
│  │ └─────────────────────────────────┘║│                    │
│  └─────────────────────────────────┘ ║│                    │
│                                       ║│                    │
│  DANH SÁCH ĐÁNH GIÁA                 ║│                    │
│  ┌─────────────────────────────────┐ ║│                    │
│  │ Bạn ★★★★☆     25/2/2026         │ ║│                    │
│  │ Dịch vụ rất tốt, tài xế thân    │ ║│                    │
│  │ thiện. Sẽ tiếp tục sử dụng.     │ ║│                    │
│  │                                 │ ║│                    │
│  │ Khách ★★★☆☆   24/2/2026        │ ║│                    │
│  │ Còn chút chờ lâu nhưng tạm được│ ║│                    │
│  └─────────────────────────────────┘ ║│                    │
│                                       ║│                    │
└──────────────────────────────────────────────────────────────┘

Star Rating:
★ (hover: gold)  ★ (hover: gold)  ★ (hover: gold)...
After click: ★★★☆☆ (filled/empty)

Review Form: Gray background card with textarea + button
Review List: New reviews at top, old at bottom
```

---

### Layout 5: Mobile View (375x812px)
```
┌───────────────────────┐
│  🚌 TRA CỨU TUYẾN    │ ← Header
│                       │
│  ┌─────────────────┐  │
│  │ [Search box]    │  │
│  │ [Search button] │  │
│  └─────────────────┘  │
│                       │
│  DANH SÁCH TUYẾN    │
│  ┌─────────────────┐  │
│  │ 01              │  │
│  │ Tuyến Hải Châu │  │
│  │ 05:00-23:00    │  │
│  ├─────────────────┤  │
│  │ 02              │  │
│  │ Tuyến Hòa Khánh│  │
│  │ 05:30-23:30    │  │
│  └─────────────────┘  │
│                       │
├───────────────────────┤
│                       │
│  ← QUY LẠI            │
│  Tuyến 01             │
│                       │
│  [Lượt Đi][Lượt V]   │
│                       │
│  [Trạm][Info][Đánh G]│
│  ═══════════════════ │
│                       │
│  ┌─────────────────┐  │
│  │ 🟢 1  Terminal │  │
│  │     ⏱️ 05:00  │  │
│  │ 🟦 2  Hàng...  │  │
│  │     ⏱️ 05:10  │  │
│  │ 🔴 3  Terminal │  │
│  │     ⏱️ 05:20  │  │
│  └─────────────────┘  │
│                       │
├───────────────────────┤
│        MAP HERE       │
│      (Leaflet)        │
│                       │
│     🟢 🟦 🔴         │
│                       │
└───────────────────────┘

Mobile Features:
- Single column layout
- Stacked map below sidebar
- CTA modal hidden
- Touch-friendly buttons
- Full width input fields
```

---

## Color Palette

```
┌─────────────┬──────────┬────────────────────────┐
│ Color       │ Hex      │ Usage                  │
├─────────────┼──────────┼────────────────────────┤
│ Teal        │ #0f766e  │ Primary buttons, icons │
│ Dark Teal   │ #134e4a  │ Header background     │
│ Green       │ #16a34a  │ Start marker, success │
│ Red         │ #dc2626  │ End marker, danger    │
│ Orange      │ #ff6b35  │ Secondary action      │
│ Gold        │ #fbbf24  │ Star ratings          │
│ Light BG    │ #f9fafb  │ Card backgrounds      │
│ Border      │ #e0e0e0  │ Input borders         │
│ Text Dark   │ #333    │ Body text             │
│ Text Light  │ #999    │ Secondary text        │
│ Neutral     │ #d1d5db  │ Disabled state        │
└─────────────┴──────────┴────────────────────────┘

Example: Button States
  Default:    Teal bg (#0f766e), white text
  Hover:      Dark Teal (#0d5d56), elevated shadow
  Active:     Dark Teal bg (#0d5d56), pressed state
  Disabled:   Gray (#d1d5db), 50% opacity
```

---

## Typography

```
Heading (Route Name)
════════════════════════════════════════════════════════════════════════
Font Size: 28px | Font Weight: 700 | Color: White | Font: Segoe UI

Sub Heading (Route Number)
────────────────────────────────────────────────────────────────────────
Font Size: 14px | Font Weight: 400 | Color: White #f0f0f0 | Opacity 0.9

Section Title (DANH SÁCH TUYẾN)
────────────────────────────────────────────────────────────────────────
Font Size: 13px | Font Weight: 600 | Color: #666 | Text Transform: UPPERCASE

Body Text (Normal content)
────────────────────────────────────────────────────────────────────────
Font Size: 13px | Font Weight: 400 | Color: #333 | Line Height: 1.5

Small Text (Secondary information)
────────────────────────────────────────────────────────────────────────
Font Size: 12px | Font Weight: 400 | Color: #999 | Opacity 0.85

Label (Form labels)
────────────────────────────────────────────────────────────────────────
Font Size: 11px | Font Weight: 600 | Color: #999 | Text Transform: UPPERCASE

Font Family: Segoe UI, Tahoma, Geneva, Verdana, sans-serif
```

---

## Interaction Patterns

### 1. Route Selection
```
User Hover:
┌─────────────────────┐
│ Route Item          │  → Light gray background
│ (Light background)  │  → Left border highlights
└─────────────────────┘

User Click:
┌─────────────────────┐
│ Route Item          │  → Dark background (selected)
│ (Dark background)   │  → Right side highlighted
│ Route #01           │  → Number turns teal color
└─────────────────────┘
```

### 2. Stop Click (FlyTo Animation)
```
Timeline:
  t=0ms:   Map centered at original location
  t=750ms: Animating... flying to stop location
  t=1500ms: Arrived at stop, zoom level 16
  
Popup:    Appears on marker when arrived
         Contains: <b>Terminal Hải Châu</b>
         Closes:   When clicking elsewhere on map
```

### 3. Star Rating Selection
```
Unselected:  ☆ ☆ ☆ ☆ ☆ (light gray, #d1d5db)

Hover:       ★ ★ ★ ☆ ☆ (gold hover on all hovered + clicked)
            
Selected:    ★ ★ ★ ☆ ☆ (gold, persistent)
             (3 stars filled, 2 empty)
```

### 4. Tab Switching
```
Inactive Tab:
┌──────────────────────┐
│ 🚏 TRẠM DỪNG          │  Color: #999 (gray)
│─────────────         │  Border: 3px solid transparent
└──────────────────────┘

Active Tab:
┌──────────────────────┐
│ 🚏 TRẠM DỪNG          │  Color: #0f766e (teal)
│═════════════════════ │  Border: 3px solid #0f766e (bottom)
└──────────────────────┘
```

---

## Animations

### 1. FlyTo Animation
```
Duration:  1.5 seconds
Easing:    Smooth (cubic-bezier)
Effect:    Zoom + Pan combined
          
Before:  Map shows city view (zoom 13)
After:   Map shows street view (zoom 16)
```

### 2. Button Hover
```
Transform: translateY(-2px)  (2px upward movement)
Duration:  0.3s
Shadow:    Box-shadow: 0 4px 12px rgba(...)
```

### 3. Tab Content Switch
```
Transition: Immediate (no animation)
Method:    CSS display change (visibility)
Effect:    Instant tab content swap
```

### 4. Polyline Draw
```
Duration:  Animation from OSRM route
Effect:    Line appears on map
Shadow:    Teal color, 5px width, 0.7 opacity
```

---

## Accessibility Features

```
Current Implementation:
  ✓ Semantic HTML tags (button, nav, section)
  ✓ Color contrast (WCAG AA compliant)
  ✓ Keyboard support (Enter to search)
  ✓ Click targets (min 44px for touch)
  ✓ Focus indicators (browser default)

Future Improvements:
  ☐ ARIA labels for landmarks
  ☐ Screen reader announcements
  ☐ Keyboard Tab navigation
  ☐ Skip to main content link
  ☐ Focus management on modals
```

---

## Responsive Breakpoints

```
Desktop (1440px):
┌─────────────────────────────────────┐
│ Sidebar (35%) │ Map (65%)           │
│ - Full search │ - Full resolution   │
│ - All UI      │ - Info panel vis    │
└─────────────────────────────────────┘

Tablet (1024px):
┌───────────────────────────────┐
│ Sidebar (40vh)                │
├───────────────────────────────┤
│ Map (60vh)                    │
│ - Info panel visible          │
│ - CTA modal visible           │
└───────────────────────────────┘

Mobile (768px):
┌────────────┐
│ Sidebar    │
│ 100%, auto │
├────────────┤
│ Map        │
│ 100%, 60vh │
│ - CTA      │
│   hidden   │
└────────────┘

Small Mobile (375px):
┌────────┐
│Sidebar │
│100%    │
│40vh    │
├────────┤
│  Map   │
│100%    │
│60vh    │
└────────┘
```

---

## Visual Hierarchy

**Primary Elements** (Most important)
- Route name heading
- Selected stop in timeline
- Active tab button
- Submit buttons

**Secondary Elements** (Important but less)
- Info cards
- Stop numbers
- Timestamps
- Distance values

**Tertiary Elements** (Supporting)
- Labels
- Placeholder text
- Border colors
- Secondary icons

**Visual Weights:**
```
Size:        Largest → Heading > Subheading > Body > Small
Weight:      Bold (700) > Semibold (600) > Normal (400)
Color:       Accent (#0f766e) > Neutral (#333) > Muted (#999)
Contrast:    White-on-teal (high) > Gray-on-white (medium)
```

---

## Error States & Validation

```
Empty Search:
Message: "Nhập từ khóa để tìm kiếm"
Style:   Centered, 13px, color #999
Icon:    None

No Results:
Message: "❌ Không tìm thấy tuyến xe"
Style:   Centered, 13px, color #999

Loading:
Message: "⏳ Đang tải dữ liệu..."
Style:   Centered, 13px, color #999
Effect:  Might add spinner in future

Form Validation (Reviews):
Error 1: "Vui lòng chọn đánh giá sao"
Error 2: "Vui lòng viết nhận xét"
Type:    Alert dialog (browser default)
Future:  Custom inline error message
```

---

## Empty States

```
Initial Load:
┌─────────────────────────────────────┐
│ 🚌 TRA CỨU TUYẾN                   │
│                                     │
│ [Search box] [Search button]        │
│                                     │
│ Nhập từ khóa để tìm kiếm           │
│                                     │
└─────────────────────────────────────┘

Map:
OpenStreetMap loaded, centered on Da Nang
Zoom level: 13 (city overview)
No markers visible until route selected
```

---

**Version:** 1.0.0  
**Last Updated:** February 2026  
**Design Status:** Finalized and Implemented
