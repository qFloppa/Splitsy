# Splitsy Motion Showreel

A 15-second, showreel-quality motion graphics piece showcasing Splitsy's core use case: sending money to anyone via X, Discord, email, or wallet address.

## 🎬 Timeline Breakdown (900 frames @ 60fps)

### Scene 1: Cold Open (0-2s, frames 0-120)
- **Logo reveal** with elastic entrance
- **Light sweep** across the frame
- **Sound**: Deep swoosh

### Scene 2: Sentence Composition (2-9s, frames 120-540)
- **"send $42 to"** types in with weight differentiation
- **Platform cycling**: Four identities rotate through
  - 180-270: X handle `@dani`
  - 270-360: Discord `dani#1234`
  - 360-450: Email `dani@me.com`
  - 450-540: Wallet `0xEE42...70AC`
- **Each transition** has particle burst and click sound
- **Note line**: "for last night's ramen 🍜" fades in below
- **Network badge**: "USDC ON ARC" top-right

### Scene 3: Settle Action (9-12s, frames 540-720)
- **Previous sentence** fades to background
- **Settle button** appears with glow
- **Button press** at frame 610 with scale squash
- **Success stamp** lands with elastic bounce and rotation
- **Confirmation rings** pulse outward
- **Sound**: Button click → success chord progression
- **Particle explosion** in success green

### Scene 4: Value Prop (12-14s, frames 720-840)
- **"Send money to anyone"** headline
- **"No wallet needed • Instant escrow"** subhead
- **Smooth entrance** with vertical drift
- **Sound**: Soft swoosh

### Scene 5: Endcard (14-15s, frames 840-900)
- **Splitsy logo** on black with cyan glow
- **splitsy.xyz** URL in cyan
- **Tagline**: "utilizing programmable money on arc"
- **Ambient particles** floating upward

## 🎨 Design Tokens

All colors and typography match `app/globals.css`:
- **Font**: Clash Display Variable (200-700 weight range)
- **Primary**: `#2775ca` (USDC blue)
- **Accent**: `#3ee6d6` (Arc cyan)
- **Success**: `#17a56b` (settled green)
- **Ink**: `#071421`
- **Ground**: `#eef3f6`

## 🔊 Sound Design

Synthesized Web Audio API sounds:
- **Swooshes**: Frequency sweep for transitions
- **Clicks**: Short sine burst for UI interactions  
- **Pops**: Pitched sine decay for platform switches
- **Success**: C-E-G major chord for settlement confirmation

## 🚀 Running Locally

```bash
cd motion-showreel

# Option 1: Simple web server
python3 -m http.server 8080

# Option 2: Node server
npx serve

# Open http://localhost:8080
```

Click **Play** to start the animation. Press again to pause.

## 📹 Exporting Video

### Method 1: Browser Recording (Quick)
1. Open in Chrome/Edge
2. Press Play
3. Use browser/OS screen recording
4. Crop to canvas area

### Method 2: Automated Rendering (Production)
```bash
npm install
npm run render
```

This uses Puppeteer to capture frames and FFmpeg to encode:
- **Output**: `splitsy-showreel.mp4`
- **Format**: 1920x1080 @ 60fps, H.264, AAC audio
- **Duration**: Exactly 15 seconds

### Method 3: OBS Studio
1. Add Browser Source pointing to `file:///path/to/index.html`
2. Set resolution to 1920x1080
3. Click Play
4. Record 15 seconds

## 🎯 Motion Design Showcase

This piece demonstrates:
- **Timing precision**: Every cut on a 60fps grid
- **Easing mastery**: Custom elastic, back, and bezier curves
- **Layered animation**: Overlapping action with proper anticipation
- **Particle systems**: Dynamic effects tied to narrative beats
- **Sound design**: Synthesized audio synchronized to visuals
- **Typography as hero**: Clash Display as the main design element
- **Color as storytelling**: Each platform gets its own accent
- **Camera movement**: Subtle drift prevents static feeling
- **Professional pacing**: 15 seconds with zero dead air

## 📝 Notes

- Font must load before rendering (uses `document.fonts.ready`)
- Audio requires user interaction to start (click Play)
- 60fps target with requestAnimationFrame
- All animations are pure functions of frame number for reproducibility
- Particle system adds organic feel without overwhelming
- Letter spacing manually implemented for precision

## 🔧 Customization

Edit `showreel.js` constants:
- **Colors**: `C` object at top
- **Timing**: Frame ranges in each `renderSceneN()` function
- **Text**: Strings in render functions
- **Easing**: `ease` object for custom curves

## 💎 Showreel Quality

This is portfolio-grade motion design:
- **Industry-standard timing**: 24-frame (0.4s) rule for eye comfort
- **Audio-visual sync**: Every visual beat has audio support
- **Professional typography**: Proper weight contrast, letter spacing
- **Kinetic energy**: Always something moving, never static
- **Clear hierarchy**: Eye naturally flows through composition
- **Brand consistency**: Every element from actual product design system
