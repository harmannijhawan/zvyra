/**
 * OWNER: Kiro. Design direction for a generated website (pure, unit-tested).
 *
 * Turns what research found (category, brand colours, what the business sells,
 * what is actually available) into a concrete brief: typography, palette tokens,
 * section plan, imagery rules, motion and the primary conversion goal. Different
 * industries get genuinely different directions, not one template recoloured.
 */

export type Category = 'restaurant' | 'cafe' | 'bakery' | 'bar' | 'jewelry' | 'salon' | 'spa' | 'fashion' | 'tech' | 'fitness' | 'clinic' | 'hotel' | 'realestate' | 'legal' | 'education' | 'retail' | 'generic'

interface Direction {
  mood: string
  fonts: { display: string; body: string; url: string }
  palette: { bg: string; surface: string; text: string; muted: string; accent: string; accent2: string }
  radius: string
  layout: string[]
  sections: string[]
  imagery: string
  motion: string
  conversion: string
  avoid: string[]
}

export const CATEGORIES: Category[] = ['restaurant', 'cafe', 'bakery', 'bar', 'jewelry', 'salon', 'spa', 'fashion', 'tech', 'fitness', 'clinic', 'hotel', 'realestate', 'legal', 'education', 'retail', 'generic']

const GF = (q: string) => `https://fonts.googleapis.com/css2?${q}&display=swap`

const DIRECTIONS: Record<Category, Direction> = {
  restaurant: {
    mood: 'Warm, appetising, confident: food is the hero, generous photography, editorial menu typography.',
    fonts: { display: 'Fraunces', body: 'Inter', url: GF('family=Fraunces:opsz,wght@9..144,500;9..144,700&family=Inter:wght@400;500;600') },
    palette: { bg: '#fbf7f2', surface: '#ffffff', text: '#1f1a17', muted: '#6b625b', accent: '#9b2c1f', accent2: '#d9a441' },
    radius: '14px',
    layout: ['Full-bleed hero photo of a signature dish with a dark gradient for legible text', 'Menu as a typeset list (name ….. price) grouped by section, not cards', 'Sticky mobile action bar: Call · Directions · WhatsApp / Reserve'],
    sections: ['Hero (name, one-line promise, Reserve/Order + Call)', 'Signature dishes (3–6, real items with real prices)', 'Full menu by section', 'Story / chef', 'Gallery', 'Hours & location (map link)', 'Reviews only if a real source exists (quote + source)', 'Contact & footer'],
    imagery: 'Real dish and interior photos from the business; crop tight on food; never stock food presented as their dishes.',
    motion: 'Subtle fade/slide-up on scroll, image zoom on hover; respect prefers-reduced-motion.',
    conversion: 'Table reservation or phone/WhatsApp order',
    avoid: ['Generic SaaS gradients', 'Invented dishes or prices', 'Tiny low-contrast menu text']
  },
  cafe: {
    mood: 'Cosy, crafted, daylight: soft neutrals, handwritten-feeling accents, community vibe.',
    fonts: { display: 'DM Serif Display', body: 'DM Sans', url: GF('family=DM+Serif+Display&family=DM+Sans:wght@400;500;700') },
    palette: { bg: '#f6f1ea', surface: '#fffdf9', text: '#2b211b', muted: '#7a6a5d', accent: '#6f4e37', accent2: '#c8a27a' },
    radius: '18px',
    layout: ['Split hero: big photo + short warm headline', 'Drinks/food menu in two columns with prices', 'Instagram-style gallery grid of real photos'],
    sections: ['Hero', 'Menu highlights', 'Full menu', 'Our space / story', 'Gallery', 'Visit us (hours, map link)', 'Contact'],
    imagery: 'Real coffee, pastries and interior shots; warm white balance.',
    motion: 'Gentle hover lifts; no heavy parallax.',
    conversion: 'Visit / directions, then order via phone or WhatsApp',
    avoid: ['Corporate blue', 'Stock latte art claimed as theirs']
  },
  bakery: {
    mood: 'Fresh, artisanal, sweet: creamy backgrounds, rich browns, close-up textures.',
    fonts: { display: 'Playfair Display', body: 'Nunito Sans', url: GF('family=Playfair+Display:wght@600;800&family=Nunito+Sans:wght@400;600;700') },
    palette: { bg: '#fff8f0', surface: '#ffffff', text: '#3a2618', muted: '#86705f', accent: '#b5651d', accent2: '#e8b4a0' },
    radius: '20px',
    layout: ['Hero with product close-up', 'Product grid with price and order button', 'Custom-order / celebration cakes section'],
    sections: ['Hero', 'Bestsellers', 'Full range with prices', 'Custom orders', 'Story', 'Visit & hours', 'Contact'],
    imagery: 'Macro shots of real products.',
    motion: 'Soft scale-in of product cards.',
    conversion: 'Pre-order via WhatsApp or call',
    avoid: ['Invented flavours or prices']
  },
  bar: {
    mood: 'Moody, nightlife, sensory: dark surfaces, neon or brass accent, big type.',
    fonts: { display: 'Bebas Neue', body: 'Manrope', url: GF('family=Bebas+Neue&family=Manrope:wght@400;600;700') },
    palette: { bg: '#0f0e0d', surface: '#1a1816', text: '#f3eee7', muted: '#a49b90', accent: '#e0a93b', accent2: '#c2413a' },
    radius: '8px',
    layout: ['Video/photo hero with dark overlay', 'Events/nights strip', 'Drinks menu typeset like a cocktail card'],
    sections: ['Hero', 'Tonight / events', 'Drinks & food menu', 'Gallery', 'Book a table', 'Hours & location', 'Contact'],
    imagery: 'Low-light venue and drink photography from the venue.',
    motion: 'Slow fades, glow on hover.',
    conversion: 'Table booking / call',
    avoid: ['Bright white backgrounds']
  },
  jewelry: {
    mood: 'Luxury, restraint, craftsmanship: lots of whitespace, fine serif, gold or deep jewel accent, slow elegant motion.',
    fonts: { display: 'Cormorant Garamond', body: 'Jost', url: GF('family=Cormorant+Garamond:wght@400;500;600&family=Jost:wght@300;400;500') },
    palette: { bg: '#faf8f5', surface: '#ffffff', text: '#1c1a17', muted: '#7d766c', accent: '#a8875a', accent2: '#0f3d3e' },
    radius: '2px',
    layout: ['Editorial hero: one hero piece, large serif headline, thin rules', 'Collections as tall image tiles', 'Craft / atelier storytelling with process photos', 'Appointment booking'],
    sections: ['Hero', 'Collections', 'Signature pieces', 'Craftsmanship / heritage', 'Bridal or bespoke', 'Visit the store / book an appointment', 'Contact'],
    imagery: 'Product shots of their own pieces on neutral backgrounds; never stock jewellery as their designs.',
    motion: 'Slow (600–900 ms) fades and image reveals.',
    conversion: 'Book an appointment / enquire on WhatsApp',
    avoid: ['Discount-store badges', 'Loud colours', 'Busy layouts']
  },
  salon: {
    mood: 'Fresh, stylish, personal: soft blush or sage, rounded shapes, before/after confidence.',
    fonts: { display: 'Marcellus', body: 'Outfit', url: GF('family=Marcellus&family=Outfit:wght@300;400;600') },
    palette: { bg: '#fbf6f4', surface: '#ffffff', text: '#2a2426', muted: '#82767a', accent: '#b76e79', accent2: '#8aa399' },
    radius: '24px',
    layout: ['Hero with stylist/result photo and Book Now', 'Services with prices and duration', 'Team cards', 'Gallery of real work'],
    sections: ['Hero', 'Services & prices', 'Team', 'Gallery', 'Reviews (real, with source)', 'Book / contact', 'Hours & location'],
    imagery: 'Their own work and space.',
    motion: 'Soft hover states; carousel only for gallery.',
    conversion: 'Book appointment (call / WhatsApp)',
    avoid: ['Invented prices', 'Stock models presented as clients']
  },
  spa: {
    mood: 'Calm, natural, restorative: muted earth tones, airy spacing, slow motion.',
    fonts: { display: 'Cormorant', body: 'Mulish', url: GF('family=Cormorant:wght@500;600&family=Mulish:wght@300;400;600') },
    palette: { bg: '#f4f1ec', surface: '#fbfaf7', text: '#2c2b27', muted: '#7b776d', accent: '#6b7f5e', accent2: '#c9b79c' },
    radius: '28px',
    layout: ['Tranquil full-width hero', 'Treatments menu with durations and prices', 'Packages'],
    sections: ['Hero', 'Treatments', 'Packages', 'The space', 'Book', 'Contact'],
    imagery: 'Their treatment rooms; natural textures.',
    motion: 'Slow fades only.',
    conversion: 'Book a treatment',
    avoid: ['High-energy colours']
  },
  fashion: {
    mood: 'Editorial, bold, trend-aware: big imagery, strong grid, oversized type.',
    fonts: { display: 'Syne', body: 'Space Grotesk', url: GF('family=Syne:wght@600;800&family=Space+Grotesk:wght@400;500') },
    palette: { bg: '#f5f4f0', surface: '#ffffff', text: '#111111', muted: '#6d6d6d', accent: '#111111', accent2: '#d4543a' },
    radius: '0px',
    layout: ['Lookbook hero (full-bleed)', 'Asymmetric product grid', 'Drops / new arrivals strip'],
    sections: ['Hero', 'New arrivals', 'Collections', 'Lookbook', 'About the label', 'Stockists / contact'],
    imagery: 'Their own campaign and product photography.',
    motion: 'Snappy hover image swaps; marquee for drops.',
    conversion: 'Shop / DM to order',
    avoid: ['Soft pastel templates']
  },
  tech: {
    mood: 'Precise, modern, trustworthy: crisp grid, product UI as hero, clear value props.',
    fonts: { display: 'Inter Tight', body: 'Inter', url: GF('family=Inter+Tight:wght@600;700;800&family=Inter:wght@400;500') },
    palette: { bg: '#0b0d12', surface: '#131722', text: '#eef1f7', muted: '#97a0b3', accent: '#5b8cff', accent2: '#2ad1a3' },
    radius: '12px',
    layout: ['Headline + subhead + product screenshot hero', 'Logo strip only with real customers', 'Feature grid with icons', 'Pricing table if prices are public'],
    sections: ['Hero', 'Problem → solution', 'Features', 'How it works', 'Pricing (real)', 'FAQ', 'CTA', 'Footer'],
    imagery: 'Real product screenshots/diagrams.',
    motion: 'Micro-interactions on buttons, subtle gradients.',
    conversion: 'Start trial / book a demo',
    avoid: ['Fake customer logos', 'Made-up metrics']
  },
  fitness: {
    mood: 'Energetic, bold, motivating: high contrast, strong condensed type.',
    fonts: { display: 'Oswald', body: 'Barlow', url: GF('family=Oswald:wght@500;700&family=Barlow:wght@400;500;600') },
    palette: { bg: '#0e0e0e', surface: '#1a1a1a', text: '#f5f5f5', muted: '#a3a3a3', accent: '#e4ff3a', accent2: '#ff5a1f' },
    radius: '6px',
    layout: ['Action hero', 'Programs/classes grid', 'Schedule table', 'Membership plans'],
    sections: ['Hero', 'Programs', 'Schedule', 'Trainers', 'Membership', 'Location', 'Contact'],
    imagery: 'Their gym and members (with permission).',
    motion: 'Punchy slide-ins.',
    conversion: 'Free trial / join',
    avoid: ['Pastels']
  },
  clinic: {
    mood: 'Reassuring, clean, accessible: calm blues/greens, large readable type, clear trust signals.',
    fonts: { display: 'Lexend', body: 'Source Sans 3', url: GF('family=Lexend:wght@500;600&family=Source+Sans+3:wght@400;600') },
    palette: { bg: '#f5f9fb', surface: '#ffffff', text: '#13232f', muted: '#5b6b77', accent: '#0f7c90', accent2: '#5cb39b' },
    radius: '14px',
    layout: ['Hero with doctor/clinic photo and Book appointment', 'Services list', 'Doctors with real credentials', 'Insurance / timings'],
    sections: ['Hero', 'Services', 'Doctors', 'Timings', 'Location', 'Book / contact'],
    imagery: 'Their clinic and staff.',
    motion: 'Minimal.',
    conversion: 'Book appointment / call',
    avoid: ['Medical claims not stated by the clinic']
  },
  hotel: {
    mood: 'Escapist, premium, spacious: large photography, refined serif, booking always visible.',
    fonts: { display: 'Libre Caslon Display', body: 'Karla', url: GF('family=Libre+Caslon+Display&family=Karla:wght@400;500;700') },
    palette: { bg: '#f7f5f1', surface: '#ffffff', text: '#1d1b18', muted: '#77726a', accent: '#24544c', accent2: '#c59b5f' },
    radius: '10px',
    layout: ['Full-screen hero with booking bar', 'Rooms as large cards', 'Amenities icons', 'Location & nearby'],
    sections: ['Hero', 'Rooms', 'Amenities', 'Dining', 'Gallery', 'Location', 'Book / contact'],
    imagery: 'Their rooms and views.',
    motion: 'Slow image reveals.',
    conversion: 'Check availability / enquire',
    avoid: ['Fake rates']
  },
  realestate: {
    mood: 'Aspirational yet factual: listings first, clean data presentation.',
    fonts: { display: 'Manrope', body: 'Manrope', url: GF('family=Manrope:wght@400;600;800') },
    palette: { bg: '#f6f7f9', surface: '#ffffff', text: '#141a22', muted: '#667085', accent: '#1d4ed8', accent2: '#c2a46b' },
    radius: '12px',
    layout: ['Search/feature hero', 'Listing cards with key facts', 'Agent profile'],
    sections: ['Hero', 'Featured properties', 'Services', 'About the agent', 'Contact'],
    imagery: 'Their listings only.',
    motion: 'Minimal.',
    conversion: 'Schedule a visit',
    avoid: ['Invented listings']
  },
  legal: {
    mood: 'Authoritative, calm, credible: navy/ink, serif headings, generous whitespace.',
    fonts: { display: 'Spectral', body: 'IBM Plex Sans', url: GF('family=Spectral:wght@500;700&family=IBM+Plex+Sans:wght@400;500') },
    palette: { bg: '#f7f7f5', surface: '#ffffff', text: '#16202c', muted: '#5f6b78', accent: '#1f3a5f', accent2: '#a48a5c' },
    radius: '4px',
    layout: ['Statement hero', 'Practice areas grid', 'Team bios'],
    sections: ['Hero', 'Practice areas', 'Team', 'Approach', 'Contact'],
    imagery: 'Their team and office.',
    motion: 'Minimal.',
    conversion: 'Book a consultation',
    avoid: ['Outcome guarantees']
  },
  education: {
    mood: 'Optimistic, clear, structured.',
    fonts: { display: 'Poppins', body: 'Poppins', url: GF('family=Poppins:wght@400;500;700') },
    palette: { bg: '#f7f8fc', surface: '#ffffff', text: '#1b1f3b', muted: '#62668a', accent: '#4f46e5', accent2: '#f59e0b' },
    radius: '16px',
    layout: ['Hero with programme promise', 'Courses grid', 'Outcomes only if stated'],
    sections: ['Hero', 'Courses', 'Faculty', 'Admissions', 'Contact'],
    imagery: 'Their campus and classes.',
    motion: 'Light.',
    conversion: 'Enquire / enrol',
    avoid: ['Invented placement numbers']
  },
  retail: {
    mood: 'Product-led, clear, shoppable.',
    fonts: { display: 'Archivo', body: 'Archivo', url: GF('family=Archivo:wght@400;600;800') },
    palette: { bg: '#fafafa', surface: '#ffffff', text: '#161616', muted: '#6b6b6b', accent: '#0f766e', accent2: '#f97316' },
    radius: '10px',
    layout: ['Hero with hero product', 'Category tiles', 'Product grid with real prices'],
    sections: ['Hero', 'Categories', 'Bestsellers', 'About', 'Store info', 'Contact'],
    imagery: 'Their products.',
    motion: 'Hover image swap.',
    conversion: 'Order / visit store',
    avoid: ['Invented products']
  },
  generic: {
    mood: 'Professional, modern, focused on the business’s single most important action.',
    fonts: { display: 'Plus Jakarta Sans', body: 'Inter', url: GF('family=Plus+Jakarta+Sans:wght@600;800&family=Inter:wght@400;500') },
    palette: { bg: '#f8fafc', surface: '#ffffff', text: '#0f172a', muted: '#64748b', accent: '#2563eb', accent2: '#f59e0b' },
    radius: '12px',
    layout: ['Clear value-prop hero', 'Services', 'Proof (only real)', 'Contact'],
    sections: ['Hero', 'Services', 'About', 'Contact'],
    imagery: 'Their own photos; otherwise clearly generic, credited stock.',
    motion: 'Subtle.',
    conversion: 'Contact / call',
    avoid: ['Placeholder text']
  }
}

const RULES: [RegExp, Category][] = [
  [/jewel|jewell|diamond|gold|silver|bridal set|ornament/i, 'jewelry'],
  [/bakery|bakehouse|patisserie|cake|bake/i, 'bakery'],
  [/caf[eé]|coffee|espresso|tea ?house|CafeOrCoffeeShop/i, 'cafe'],
  [/\bbar\b|pub|brewery|lounge|cocktail|BarOrPub|winery/i, 'bar'],
  [/restaurant|FoodEstablishment|dhaba|bistro|kitchen|biryani|pizza|grill|eatery|diner|deli\b|delicatessen|steakhouse|sushi|taqueria|trattoria|food/i, 'restaurant'],
  [/spa\b|DaySpa|massage|wellness/i, 'spa'],
  [/salon|HairSalon|BeautySalon|NailSalon|barber|beauty|makeup/i, 'salon'],
  [/boutique|fashion|apparel|clothing|ClothingStore|couture|label|wear/i, 'fashion'],
  [/gym|fitness|ExerciseGym|yoga|crossfit|pilates/i, 'fitness'],
  [/clinic|dental|Dentist|hospital|Physician|MedicalClinic|doctor|physio/i, 'clinic'],
  [/hotel|resort|LodgingBusiness|homestay|villa|hostel/i, 'hotel'],
  [/real ?estate|RealEstateAgent|realty|properties|builder/i, 'realestate'],
  [/law|legal|Attorney|advocate|LegalService|solicitor/i, 'legal'],
  [/school|academy|institute|EducationalOrganization|coaching|tuition|university/i, 'education'],
  [/software|saas|app\b|startup|technolog|platform|ai\b|cloud|OnlineBusiness|Corporation/i, 'tech'],
  [/store|shop|retail|mart|Store\b/i, 'retail']
]

/** First hint that matches wins, so pass the strongest evidence first (schema.org type, then name, then description). */
export function detectCategory(...hints: (string | undefined | null)[]): Category {
  for (const h of hints) {
    if (!h) continue
    for (const [re, c] of RULES) if (re.test(h)) return c
  }
  return 'generic'
}

/* ---------------------------------------------------------------- colour */

const hex = (h: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim())
  return m ? `#${m[1].toLowerCase()}` : null
}
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const lum = (h: string) => {
  const [r, g, b] = rgb(h).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export function contrast(a: string, b: string) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
const mix = (a: string, b: string, t: number) =>
  '#' +
  rgb(a)
    .map((v, i) => Math.round(v + (rgb(b)[i] - v) * t))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')

/** Darkens/lightens an accent until it is readable as text on `bg` (WCAG AA 4.5:1). */
export function readableOn(color: string, bg: string): string {
  let c = color
  const toward = lum(bg) > 0.5 ? '#000000' : '#ffffff'
  for (let i = 0; i < 20 && contrast(c, bg) < 4.5; i++) c = mix(c, toward, 0.12)
  return c
}

export interface DesignBrief {
  category: Category
  mood: string
  fonts: Direction['fonts']
  tokensCss: string
  palette: Direction['palette'] & { onAccent: string }
  brandColorsUsed: string[]
  layout: string[]
  sections: string[]
  imagery: string
  motion: string
  conversion: string
  avoid: string[]
  contentRules: string[]
}

export function designBrief(input: { category?: Category; hints?: string[]; brandColors?: string[]; themeColor?: string; available?: { menu: number; products: number; images: number; phone: boolean; whatsapp: boolean; address: boolean; hours: boolean } }): DesignBrief {
  const category = input.category ?? detectCategory(...(input.hints ?? []))
  const d = DIRECTIONS[category]
  const brand = [input.themeColor, ...(input.brandColors ?? [])].map((c) => (c ? hex(c) : null)).filter((c): c is string => !!c)
  const palette = { ...d.palette }
  if (brand[0]) palette.accent = brand[0]
  if (brand[1]) palette.accent2 = brand[1]
  // The accent must be usable for links/text on the background.
  palette.accent = readableOn(palette.accent, palette.bg)
  const onAccent = contrast('#ffffff', palette.accent) >= 4.5 ? '#ffffff' : '#111111'
  const tokensCss = [
    ':root {',
    `  --bg: ${palette.bg};`,
    `  --surface: ${palette.surface};`,
    `  --text: ${palette.text};`,
    `  --muted: ${palette.muted};`,
    `  --accent: ${palette.accent};`,
    `  --accent-2: ${palette.accent2};`,
    `  --on-accent: ${onAccent};`,
    `  --radius: ${d.radius};`,
    `  --font-display: '${d.fonts.display}', Georgia, serif;`,
    `  --font-body: '${d.fonts.body}', system-ui, sans-serif;`,
    '  --space-1: 0.25rem; --space-2: 0.5rem; --space-3: 1rem; --space-4: 1.5rem; --space-5: 2.5rem; --space-6: 4rem; --space-7: 6rem;',
    '  --step--1: clamp(0.83rem, 0.8rem + 0.15vw, 0.94rem); --step-0: clamp(1rem, 0.95rem + 0.25vw, 1.13rem);',
    '  --step-1: clamp(1.25rem, 1.1rem + 0.6vw, 1.6rem); --step-2: clamp(1.6rem, 1.3rem + 1.4vw, 2.4rem); --step-3: clamp(2.2rem, 1.6rem + 3vw, 4.2rem);',
    '  --shadow: 0 1px 2px rgb(0 0 0 / .06), 0 8px 24px rgb(0 0 0 / .08);',
    '  --ease: cubic-bezier(.2,.7,.2,1);',
    '}',
    '@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }'
  ].join('\n')
  const a = input.available
  const contentRules = [
    'Use only facts from research/dossier.json. Every price, dish, product, phone, address, hour and rating on the page must exist there; leave out what is unavailable rather than inventing it.',
    'Images: use files in assets/images (see assets/CREDITS.json). Official photos may illustrate the business; stock photos (kind "stock") only as generic mood imagery, credited in the footer, never captioned as their food/products/premises.',
    'If a section has no real content (no menu found, no reviews), omit it or replace it with a clear call to action (e.g. “Ask us for today’s menu on WhatsApp”).',
    'Put a small “Content sources” note in the footer comment or a credits page listing the source URLs.',
    ...(a && !a.menu && !a.products ? ['No menu or product list was found: do not create one. Feature the call/WhatsApp action instead.'] : []),
    ...(a && !a.phone && !a.whatsapp ? ['No verified phone or WhatsApp: use a contact form placeholder that clearly says “contact details to be confirmed”, or ask the user.'] : []),
    ...(a && !a.images ? ['No usable images were found: use typography, colour and pattern; do not fake product photos.'] : [])
  ]
  return { category, mood: d.mood, fonts: d.fonts, tokensCss, palette: { ...palette, onAccent }, brandColorsUsed: brand.slice(0, 2), layout: d.layout, sections: d.sections, imagery: d.imagery, motion: d.motion, conversion: d.conversion, avoid: d.avoid, contentRules }
}
