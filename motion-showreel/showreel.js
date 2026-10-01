// Splitsy Motion Showreel - 15 seconds of pure motion design excellence
// 1920x1080 @ 60fps

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { alpha: false });
const loadingEl = document.getElementById('loading');

// Design tokens from Splitsy
const C = {
  ink: '#071421',
  ground: '#eef3f6',
  accent: '#2775ca',
  accentStrong: '#0a4f96',
  cyan: '#3ee6d6',
  success: '#17a56b',
  dim: 'rgba(7, 20, 33, 0.75)',
  rule: 'rgba(7, 20, 33, 0.14)',
  discord: '#5865f2',
};

// Canvas setup
const W = 1920;
const H = 1080;
const CX = W / 2;
const CY = H / 2;

canvas.width = W;
canvas.height = H;

// Animation state
let isPlaying = false;
let startTime = 0;
let currentFrame = 0;
const FPS = 60;
const DURATION = 15; // seconds
const TOTAL_FRAMES = FPS * DURATION;

// Audio context for sound design
let audioCtx;
let masterGain;
let audioReady = false;

// Initialize audio
function initAudio() {
  if (audioCtx) return;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.7;
  masterGain.connect(audioCtx.destination);
  audioReady = true;
}

// Sound synthesis functions
function playSwoosh(time = 0, freq = 400, duration = 0.3) {
  if (!audioReady) return;

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  const filter = audioCtx.createBiquadFilter();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, audioCtx.currentTime + time);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.3, audioCtx.currentTime + time + duration);

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(2000, audioCtx.currentTime + time);

  gain.gain.setValueAtTime(0.3, audioCtx.currentTime + time);
  gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + time + duration);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);

  osc.start(audioCtx.currentTime + time);
  osc.stop(audioCtx.currentTime + time + duration);
}

function playClick(time = 0) {
  if (!audioReady) return;

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = 'sine';
  osc.frequency.value = 800;

  gain.gain.setValueAtTime(0.15, audioCtx.currentTime + time);
  gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + time + 0.05);

  osc.connect(gain);
  gain.connect(masterGain);

  osc.start(audioCtx.currentTime + time);
  osc.stop(audioCtx.currentTime + time + 0.05);
}

function playPop(time = 0, freq = 600) {
  if (!audioReady) return;

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, audioCtx.currentTime + time);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.5, audioCtx.currentTime + time + 0.1);

  gain.gain.setValueAtTime(0.25, audioCtx.currentTime + time);
  gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + time + 0.15);

  osc.connect(gain);
  gain.connect(masterGain);

  osc.start(audioCtx.currentTime + time);
  osc.stop(audioCtx.currentTime + time + 0.15);
}

function playSuccess(time = 0) {
  if (!audioReady) return;

  const notes = [523.25, 659.25, 783.99]; // C, E, G chord
  notes.forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'sine';
    osc.frequency.value = freq;

    gain.gain.setValueAtTime(0.1, audioCtx.currentTime + time + i * 0.05);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + time + 0.5);

    osc.connect(gain);
    gain.connect(masterGain);

    osc.start(audioCtx.currentTime + time + i * 0.05);
    osc.stop(audioCtx.currentTime + time + 0.6);
  });
}

// Easing functions
const ease = {
  out: (t) => 1 - Math.pow(1 - t, 3),
  in: (t) => t * t * t,
  inOut: (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  elastic: (t) => {
    const c4 = (2 * Math.PI) / 3;
    return t === 0 ? 0 : t === 1 ? 1 :
      Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
  back: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }
};

// Utility functions
function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

function progress(frame, start, end) {
  return clamp((frame - start) / (end - start), 0, 1);
}

// Particle system for effects
class Particle {
  constructor(x, y, vx, vy, color, size, life) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.color = color;
    this.size = size;
    this.life = life;
    this.maxLife = life;
    this.gravity = 0.2;
  }

  update() {
    this.x += this.vx;
    this.y += this.vy;
    this.vy += this.gravity;
    this.vx *= 0.98;
    this.vy *= 0.98;
    this.life--;
  }

  draw(ctx) {
    const alpha = this.life / this.maxLife;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  isDead() {
    return this.life <= 0;
  }
}

const particles = [];

function spawnParticles(x, y, count, color) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 8 + 2;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;
    const size = Math.random() * 4 + 2;
    const life = Math.random() * 30 + 20;
    particles.push(new Particle(x, y, vx, vy, color, size, life));
  }
}

// Text rendering with proper Clash Display styling
function drawText(text, x, y, size, weight = 300, align = 'center', color = C.ink, letterSpacing = -0.03) {
  ctx.save();
  ctx.font = `${weight} ${size}px ClashDisplay, sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';

  // Manual letter spacing
  if (letterSpacing !== 0 && align === 'center') {
    const metrics = ctx.measureText(text);
    const totalSpacing = letterSpacing * size * (text.length - 1);
    const totalWidth = metrics.width + totalSpacing;
    let currentX = x - totalWidth / 2;

    for (let char of text) {
      ctx.fillText(char, currentX, y);
      currentX += ctx.measureText(char).width + letterSpacing * size;
    }
  } else {
    ctx.fillText(text, x, y);
  }

  ctx.restore();
}

// Draw logo with glow effect
function drawLogo(x, y, scale, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;

  // Simplified Splitsy wordmark
  ctx.font = `300 ${80 * scale}px ClashDisplay, sans-serif`;
  ctx.fillStyle = C.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Add glow
  ctx.shadowColor = C.cyan;
  ctx.shadowBlur = 30 * scale;
  ctx.fillText('splitsy', x, y);
  ctx.shadowBlur = 0;

  ctx.restore();
}

// Scene rendering functions
let soundsTriggered = {};

function resetSoundTriggers() {
  soundsTriggered = {};
}

function triggerSoundOnce(key, soundFunc, time) {
  if (!soundsTriggered[key]) {
    soundFunc(time);
    soundsTriggered[key] = true;
  }
}

// Scene 1: Cold open with logo (0-2s, frames 0-120)
function renderScene1(frame) {
  const t = progress(frame, 0, 120);
  const reveal = ease.out(progress(frame, 0, 60));
  const hold = progress(frame, 60, 100);
  const exit = ease.in(progress(frame, 100, 120));

  if (frame === 1) {
    triggerSoundOnce('logo_swoosh', playSwoosh, 0);
  }

  // Animated background
  const bgShift = Math.sin(frame * 0.02) * 5;
  ctx.fillStyle = C.ink;
  ctx.fillRect(0, 0, W, H);

  // Logo entrance with scale and glow
  const logoScale = lerp(0.8, 1, reveal) * (1 - exit * 0.1);
  const logoY = CY + (1 - reveal) * 100 - exit * 80;
  const logoAlpha = reveal * (1 - exit);

  drawLogo(CX, logoY, logoScale, logoAlpha);

  // Accent line sweep
  if (reveal > 0 && reveal < 1) {
    const lineX = lerp(-200, W + 200, reveal);
    const grad = ctx.createLinearGradient(lineX - 200, 0, lineX + 200, 0);
    grad.addColorStop(0, 'rgba(62, 230, 214, 0)');
    grad.addColorStop(0.5, 'rgba(62, 230, 214, 0.5)');
    grad.addColorStop(1, 'rgba(62, 230, 214, 0)');

    ctx.fillStyle = grad;
    ctx.fillRect(lineX - 200, 0, 400, H);
  }
}

// Scene 2: Main sentence composition (2-10s, frames 120-600)
function renderScene2(frame) {
  ctx.fillStyle = C.ground;
  ctx.fillRect(0, 0, W, H);

  const sentenceY = 400;

  // "send $42 to" appears (frames 120-180)
  const part1 = progress(frame, 120, 180);
  if (part1 > 0) {
    const reveal1 = ease.out(part1);
    const y1 = sentenceY + (1 - reveal1) * 50;
    ctx.globalAlpha = reveal1;
    drawText('send ', CX - 250, y1, 120, 300, 'right', C.ink);
    drawText('$42', CX - 240, y1, 120, 500, 'left', C.accent);
    drawText(' to', CX - 60, y1, 120, 300, 'left', C.ink);
    ctx.globalAlpha = 1;

    if (frame === 121) {
      triggerSoundOnce('send_pop', () => playPop(0, 400), 0);
    }
  }

  // Platform icons cycle through: X, Discord, Email, Wallet (frames 180-540)
  const platforms = [
    { name: '@dani', icon: '𝕏', color: C.ink, start: 180, end: 270 },
    { name: 'dani#1234', icon: '◆', color: C.discord, start: 270, end: 360 },
    { name: 'dani@me.com', icon: '✉', color: C.accent, start: 360, end: 450 },
    { name: '0xEE42...70AC', icon: '⬡', color: C.cyan, start: 450, end: 540 }
  ];

  platforms.forEach((platform, idx) => {
    const t = progress(frame, platform.start, platform.end);
    if (t > 0 && t < 1) {
      const enter = ease.back(Math.min(progress(frame, platform.start, platform.start + 30), 1));
      const exit = ease.in(progress(frame, platform.end - 30, platform.end));

      const alpha = enter * (1 - exit);
      const scale = lerp(0.7, 1, enter) * lerp(1, 0.8, exit);
      const y = sentenceY + (1 - enter) * 60 + exit * 60;

      ctx.globalAlpha = alpha;
      ctx.save();
      ctx.translate(CX + 100, y);
      ctx.scale(scale, scale);

      // Icon
      drawText(platform.icon, -150, 0, 80, 400, 'center', platform.color, 0);

      // Handle/address
      drawText(platform.name, 50, 0, 100, 400, 'left', platform.color, -0.02);

      ctx.restore();
      ctx.globalAlpha = 1;

      if (frame === platform.start + 1) {
        triggerSoundOnce(`platform_${idx}`, () => playClick(0), 0);
        spawnParticles(CX + 100, y, 15, platform.color);
      }
    }
  });

  // Draw "for ramen 🍜" note below (frames 200-540)
  const noteReveal = ease.out(progress(frame, 200, 240));
  if (noteReveal > 0) {
    ctx.globalAlpha = noteReveal * 0.7;
    drawText('for last night\'s ramen 🍜', CX, 580, 40, 300, 'center', C.dim, 0);
    ctx.globalAlpha = 1;
  }

  // Network indicator top right (frames 140-540)
  const networkReveal = ease.out(progress(frame, 140, 170));
  if (networkReveal > 0 && frame < 540) {
    ctx.globalAlpha = networkReveal;
    drawText('USDC ON ARC', W - 100, 80, 20, 500, 'right', C.dim, 0.18);
    ctx.globalAlpha = 1;
  }
}

// Scene 3: Settle action with particle explosion (10-12s, frames 540-720)
function renderScene3(frame) {
  ctx.fillStyle = C.ground;
  ctx.fillRect(0, 0, W, H);

  const t = progress(frame, 540, 720);

  // Previous sentence fades
  const sentenceFade = 1 - ease.in(progress(frame, 540, 570));
  if (sentenceFade > 0) {
    ctx.globalAlpha = sentenceFade * 0.3;
    drawText('send $42 to 0xEE42...70AC', CX, 400, 100, 300, 'center', C.dim);
    ctx.globalAlpha = 1;
  }

  // "Settle" button appears and gets pressed (frames 570-630)
  const buttonReveal = ease.out(progress(frame, 570, 600));
  const buttonPress = progress(frame, 610, 620);
  const buttonPressAmount = ease.inOut(buttonPress) * (1 - ease.out(progress(frame, 620, 630)));

  if (buttonReveal > 0) {
    const btnY = CY + (1 - buttonReveal) * 100;
    const btnScale = 1 - buttonPressAmount * 0.1;

    ctx.save();
    ctx.translate(CX, btnY);
    ctx.scale(btnScale, btnScale);

    // Button background
    const btnWidth = 300;
    const btnHeight = 90;
    ctx.fillStyle = C.accent;
    ctx.shadowColor = C.accent;
    ctx.shadowBlur = 20 + buttonPressAmount * 30;
    roundRect(ctx, -btnWidth / 2, -btnHeight / 2, btnWidth, btnHeight, 45, true);
    ctx.shadowBlur = 0;

    // Button text
    drawText('SETTLE', 0, 0, 40, 600, 'center', '#ffffff', 0.1);

    ctx.restore();

    if (frame === 611) {
      triggerSoundOnce('settle_click', () => playClick(0), 0);
      spawnParticles(CX, btnY, 30, C.accent);
    }
  }

  // Success stamp animation (frames 630-720)
  const stampReveal = ease.elastic(progress(frame, 630, 670));
  if (stampReveal > 0) {
    const stampScale = stampReveal;
    const stampRotation = -7 * Math.PI / 180;

    ctx.save();
    ctx.translate(CX, CY + 100);
    ctx.rotate(stampRotation);
    ctx.scale(stampScale, stampScale);

    // Stamp border
    ctx.strokeStyle = C.success;
    ctx.lineWidth = 4;
    ctx.shadowColor = C.success;
    ctx.shadowBlur = 20;
    roundRect(ctx, -180, -50, 360, 100, 10, false, true);
    ctx.shadowBlur = 0;

    // Stamp text
    drawText('SETTLED ON ARC', 0, 0, 36, 700, 'center', C.success, 0.08);

    ctx.restore();

    if (frame === 631) {
      triggerSoundOnce('success_sound', playSuccess, 0);
      spawnParticles(CX, CY + 100, 50, C.success);
    }

    // Success rings
    const ring1 = ease.out(progress(frame, 635, 670));
    const ring2 = ease.out(progress(frame, 645, 680));

    [ring1, ring2].forEach((ringProgress, idx) => {
      if (ringProgress > 0 && ringProgress < 1) {
        ctx.globalAlpha = (1 - ringProgress) * 0.7;
        ctx.strokeStyle = C.success;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(CX, CY + 100, 80 + ringProgress * 150, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    });
  }
}

// Scene 4: Final message (12-14s, frames 720-840)
function renderScene4(frame) {
  ctx.fillStyle = C.ground;
  ctx.fillRect(0, 0, W, H);

  const titleReveal = ease.out(progress(frame, 720, 760));
  const subtitleReveal = ease.out(progress(frame, 750, 790));
  const exit = ease.in(progress(frame, 820, 840));

  if (titleReveal > 0) {
    const y1 = CY - 50 + (1 - titleReveal) * 80 - exit * 60;
    ctx.globalAlpha = titleReveal * (1 - exit);

    drawText('Send money to', CX, y1, 90, 300, 'center', C.ink);
    drawText('anyone', CX, y1 + 110, 110, 500, 'center', C.accent);

    ctx.globalAlpha = 1;

    if (frame === 721) {
      triggerSoundOnce('anyone_swoosh', () => playSwoosh(0, 300, 0.4), 0);
    }
  }

  if (subtitleReveal > 0) {
    const y2 = CY + 150 + (1 - subtitleReveal) * 40 - exit * 40;
    ctx.globalAlpha = subtitleReveal * (1 - exit) * 0.8;

    drawText('No wallet needed • Instant escrow', CX, y2, 32, 400, 'center', C.dim, 0);

    ctx.globalAlpha = 1;
  }
}

// Scene 5: Endcard with logo (14-15s, frames 840-900)
function renderScene5(frame) {
  ctx.fillStyle = C.ink;
  ctx.fillRect(0, 0, W, H);

  const reveal = ease.out(progress(frame, 840, 870));

  if (reveal > 0) {
    const logoY = CY - 50 + (1 - reveal) * 60;
    const logoScale = 0.9 + reveal * 0.1;

    drawLogo(CX, logoY, logoScale, reveal);

    // URL below
    const urlY = CY + 100 + (1 - reveal) * 40;
    ctx.globalAlpha = reveal;
    drawText('splitsy.xyz', CX, urlY, 38, 500, 'center', C.cyan, 0.05);

    // Tagline
    const tagY = CY + 170 + (1 - reveal) * 40;
    drawText('utilizing programmable money on arc', CX, tagY, 24, 400, 'center', C.dim, 0.1);

    ctx.globalAlpha = 1;
  }

  // Subtle particle float
  if (frame > 860 && frame % 10 === 0) {
    spawnParticles(
      Math.random() * W,
      H + 20,
      1,
      C.cyan
    );
  }
}

// Helper: rounded rectangle
function roundRect(ctx, x, y, w, h, r, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

// Main render function
function render(frame) {
  // Update particles
  particles.forEach(p => p.update());
  for (let i = particles.length - 1; i >= 0; i--) {
    if (particles[i].isDead()) {
      particles.splice(i, 1);
    }
  }

  // Render appropriate scene
  if (frame < 120) {
    renderScene1(frame);
  } else if (frame < 540) {
    renderScene2(frame);
  } else if (frame < 720) {
    renderScene3(frame);
  } else if (frame < 840) {
    renderScene4(frame);
  } else {
    renderScene5(frame);
  }

  // Draw particles on top
  particles.forEach(p => p.draw(ctx));

  // Debug frame counter (optional)
  // ctx.fillStyle = 'rgba(255,255,255,0.5)';
  // ctx.font = '16px monospace';
  // ctx.fillText(`Frame: ${frame}/${TOTAL_FRAMES}`, 20, 30);
}

// Animation loop
function animate(timestamp) {
  if (!isPlaying) return;

  if (!startTime) startTime = timestamp;
  const elapsed = (timestamp - startTime) / 1000;
  currentFrame = Math.floor(elapsed * FPS);

  if (currentFrame >= TOTAL_FRAMES) {
    currentFrame = 0;
    startTime = timestamp;
    resetSoundTriggers();
  }

  render(currentFrame);
  requestAnimationFrame(animate);
}

// Controls
document.getElementById('playBtn').addEventListener('click', () => {
  initAudio();
  if (!isPlaying) {
    isPlaying = true;
    startTime = 0;
    currentFrame = 0;
    resetSoundTriggers();
    requestAnimationFrame(animate);
    document.getElementById('playBtn').textContent = 'Pause';
  } else {
    isPlaying = false;
    document.getElementById('playBtn').textContent = 'Play';
  }
});

// Video export functionality
document.getElementById('exportBtn').addEventListener('click', async () => {
  alert('To export:\n\n1. Use browser screen recording\n2. Or use a tool like OBS to capture the canvas\n3. For production: Use CanvasRecorder library or server-side rendering with puppeteer + ffmpeg');
});

// Wait for font to load
document.fonts.ready.then(() => {
  loadingEl.style.display = 'none';
  // Render first frame
  render(0);
});
