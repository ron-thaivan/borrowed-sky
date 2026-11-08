// Read current positions; cached intersection coordinates become stale on long sections.
const links=[...document.querySelectorAll('.workspace-rail nav a')];
function activate(id){for(const link of links){if(link.hash==='#'+id)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current');}}
for(const link of links)link.addEventListener('click',()=>activate(link.hash.slice(1)));
let scheduled=false;
function update(){
 scheduled=false;
 const header=document.querySelector('.app-header'),rail=document.querySelector('.workspace-rail');
 const edge=Math.max(header?.getBoundingClientRect().bottom||0,window.innerWidth<=760?rail?.getBoundingClientRect().bottom||0:0)+28;
 const sections=links.filter(link=>!link.hidden).map(link=>document.querySelector(link.hash)).filter(section=>section&&section.getClientRects().length);
 const current=sections.filter(section=>section.getBoundingClientRect().top<=edge).at(-1)||sections[0];
 if(current)activate(current.id);
}
function schedule(){if(!scheduled){scheduled=true;requestAnimationFrame(update);}}
window.addEventListener('scroll',schedule,{passive:true});
window.addEventListener('resize',schedule);
schedule();
