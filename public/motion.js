// Navigation follows visible sections; no decorative animation loop.
const links=[...document.querySelectorAll('.workspace-rail nav a')];
function activate(id){for(const link of links){if(link.hash==='#'+id)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current');}}
for(const link of links)link.addEventListener('click',()=>activate(link.hash.slice(1)));
if(typeof IntersectionObserver!=='undefined'){
 const visible=new Map();
 const observer=new IntersectionObserver(entries=>{
  for(const entry of entries){if(entry.isIntersecting)visible.set(entry.target.id,entry.boundingClientRect.top);else visible.delete(entry.target.id);}
  const first=[...visible].sort((a,b)=>a[1]-b[1])[0];if(first)activate(first[0]);
 },{rootMargin:'-100px 0px -55% 0px',threshold:0});
 for(const link of links){const target=document.querySelector(link.hash);if(target)observer.observe(target);}
}
