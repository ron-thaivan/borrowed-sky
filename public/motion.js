// Ease between scroll samples at display refresh rate, then stop when settled.
const hero = document.querySelector('.intro');
const header = document.querySelector('header');
const room = document.querySelector('#room');
const preference = matchMedia('(prefers-reduced-motion: reduce)');
const reveals = [...document.querySelectorAll('.how-it-works > .eyebrow, .how-it-works > h2, .steps article, .studio-heading > *, .lobby > div')];
let observer;
let frame = 0;
let current = 0;
let previousTime = 0;
let heroTop = 0;
let heroHeight = 1;
let strength = 1;
let visible = true;
const copy = hero.querySelector('.hero-copy');
const left = hero.querySelector('.left-card');
const center = hero.querySelector('.center-card');
const right = hero.querySelector('.right-card');
const orbit = hero.querySelector('.orbit-art');
const backdrop = document.createElement('div');
backdrop.className = 'hero-backdrop';
backdrop.setAttribute('aria-hidden', 'true');
hero.prepend(backdrop);
hero.classList.add('motion-enhanced');
const layers = [backdrop, copy, left, center, right, orbit];

function measure() {
  const bounds = hero.getBoundingClientRect();
  heroTop = bounds.top + scrollY;
  heroHeight = Math.max(1, bounds.height);
  strength = innerWidth < 600 ? 0.45 : 1;
  schedule();
}

function apply(progress) {
  // Direct transforms avoid inherited CSS-variable invalidation of the subtree.
  backdrop.style.transform = `translate3d(0,${progress * 100}px,0)`;
  copy.style.transform = `translate3d(0,${progress * 45}px,0)`;
  left.style.transform = `translate3d(${-progress * 110}px,${42-progress * 90}px,0) rotate(${-7-progress * 6}deg)`;
  center.style.transform = `translate3d(0,${15-progress * 65}px,0) scale(${1+progress * .045})`;
  right.style.transform = `translate3d(${progress * 110}px,${50-progress * 55}px,0) rotate(${7+progress * 6}deg)`;
  orbit.style.transform = `rotate(${progress * 80}deg)`;
}

function paint(time) {
  frame = 0;
  const inRoom = !room.hidden;
  header.classList.toggle('scrolled', scrollY > 32 || inRoom);
  const active = !preference.matches && !inRoom && visible && !document.hidden;
  hero.classList.toggle('motion-active', active);
  if (!active) {
    previousTime = 0;
    if (preference.matches || inRoom) {
      current = 0;
      for (const layer of layers) layer.style.removeProperty('transform');
    }
    return;
  }
  const target = Math.max(0, Math.min(1, (scrollY - heroTop) / heroHeight)) * strength;
  const delta = previousTime ? Math.min(64, time - previousTime) : 16.67;
  previousTime = time;
  // Time-based damping stays consistent on 60, 120 and 144 Hz displays.
  current += (target - current) * (1 - Math.exp(-delta / 85));
  const settled = Math.abs(target - current) < .0001;
  if (settled) current = target;
  apply(current);
  if (!settled) schedule();
  else previousTime = 0;
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(paint);
}

function configure() {
  observer?.disconnect();
  for (const element of reveals) element.classList.remove('reveal-pending');
  if (!preference.matches && 'IntersectionObserver' in window) {
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        entry.target.classList.remove('reveal-pending');
        observer.unobserve(entry.target);
      }
    }, {threshold: 0.12, rootMargin: '0px 0px -24px 0px'});
    for (const element of reveals) {
      // Already visible content must never disappear when restoring a session.
      if (element.getBoundingClientRect().top > innerHeight) {
        element.classList.add('reveal-pending');
        observer.observe(element);
      }
    }
  }
  schedule();
}

// Keyboard focus always reveals form controls immediately.
document.addEventListener('focusin', event => {
  event.target.closest('.reveal-pending')?.classList.remove('reveal-pending');
});
addEventListener('scroll', schedule, {passive:true});
addEventListener('resize', measure, {passive:true});
document.addEventListener('visibilitychange', schedule);
preference.addEventListener('change', configure);
new MutationObserver(() => {
  if (!room.hidden) for (const element of reveals) element.classList.remove('reveal-pending');
  measure();
}).observe(room, {attributes:true, attributeFilter:['hidden']});
if ('IntersectionObserver' in window) {
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    schedule();
  }).observe(hero);
}
if ('ResizeObserver' in window) new ResizeObserver(measure).observe(hero);
measure();
configure();
