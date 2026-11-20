/**
 * Interactive 3D "one record, every dimension" graphic shown in the welcome page's "Enterprise-grade" band.
 * Self-contained HTML rendered in a sandboxed iframe through srcDoc, so it needs no
 * public route and keeps its own styles and script away from the page.
 * Pinned to its dark theme, on a transparent background, to sit on the dark band.
 */
export const RECORD_CUBE_HTML = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>tapestr.ai · One record, every dimension</title>
<style>
:root{--bg:#fff;--ink:#0a1a3f;--mute:#5d6678;--plate:#f5f7fb;--plate-b:#e1e6ee;--tile:#fff;--tile-b:#d3d8e0;--tint:#e3efff;--b1:#00a8ff;--b2:#0057c8;--navy:#0a1a3f;--gray:#c9ced8;--tag:#eef1f6;color-scheme:light dark;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0a1230;--ink:#eef2ff;--mute:#a9b3cc;--plate:#111b42;--plate-b:#22305f;--tile:#18254f;--tile-b:#2c3b70;--tint:#1f3470;--navy:#c9d3ff;--tag:#1b2858}}
:root[data-theme="dark"]{--bg:#0a1230;--ink:#eef2ff;--mute:#a9b3cc;--plate:#111b42;--plate-b:#22305f;--tile:#18254f;--tile-b:#2c3b70;--tint:#1f3470;--navy:#c9d3ff;--tag:#1b2858}
html,body{height:100%;margin:0}
body{background:transparent;color:var(--ink);font:15px/1.3 "Avenir Next","Century Gothic","Segoe UI",system-ui,sans-serif;overflow:hidden}
#stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;perspective:1800px;perspective-origin:50% 35%;box-sizing:border-box;cursor:grab;
 --tilt:56deg;--spin:0deg;--cw:70px;--ch:50px;--g:9px;--pad:14px;--G:150px;--Sw:300px;--Sh:200px;--rw:22px;--fc:12px;--fr:12px;--ft:12px;--sl:0px;--sr:0px}
#stage.drag{cursor:grabbing}
#scene{position:relative;width:var(--Sw);height:var(--Sh);margin-left:calc(var(--sl) - var(--sr));transform-style:preserve-3d;transform:rotateX(var(--tilt)) rotateZ(var(--spin))}
.layer{position:absolute;inset:0;transform-style:preserve-3d;transform:translateZ(var(--z));border-radius:calc(var(--ch)*.4);background:var(--plate);border:1px solid var(--plate-b);transition:opacity .4s}
.layer.dim{opacity:.2}
.grid{position:absolute;inset:var(--pad);display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);gap:var(--g);transform-style:preserve-3d}
.tile{border:1px solid var(--tile-b);background:var(--tile);border-radius:calc(var(--ch)*.28);cursor:pointer;padding:0;transition:background .3s}
.tile.t{background:var(--tint)}
.tile.sel{background:linear-gradient(135deg,var(--b1),var(--b2));border-color:transparent}
.tile:focus-visible{outline:3px solid var(--b1);outline-offset:2px}
.ribbon{position:absolute;pointer-events:none;width:var(--rw);height:calc(var(--G)*2);
 left:calc(var(--pad) + var(--col)*(var(--cw) + var(--g)) + var(--cw)/2 - var(--rw)/2);top:calc(var(--pad) + var(--row)*(var(--ch) + var(--g)) + var(--ch)/2);
 transform-origin:50% 0;transform:translateZ(calc(-1*var(--G))) rotateX(90deg);transition:left .7s ease,top .7s ease;border-radius:5px;
 background:linear-gradient(90deg,#0a8cff 0 34%,#0a1a3f 34% 67%,#c9ced8 67%)}
.ribbon::after{content:"";position:absolute;inset:0;border-radius:5px;background:repeating-linear-gradient(180deg,transparent 0 42px,rgba(255,255,255,.6) 54px,transparent 70px);animation:flow 2.2s linear infinite}
@keyframes flow{to{background-position:0 70px}}
.lbl{position:absolute;display:flex;white-space:nowrap;transform-origin:50% 100%;transform:translateZ(var(--G)) rotateZ(calc(-1*var(--spin))) rotateX(calc(-1*var(--tilt)));font-weight:700;line-height:1.1;transition:opacity .3s;opacity:.5;pointer-events:none}
.lbl.on{opacity:1}
.col{bottom:calc(100% + 6px);width:var(--cw);justify-content:center;font-size:var(--fc);color:var(--b2)}
:root[data-theme="dark"] .col{color:#5cc8ff}
.row{right:calc(100% + 8px);height:var(--ch);align-items:center;justify-content:flex-end;transform-origin:100% 50%;font-size:var(--fr);color:var(--navy)}
.tag{left:calc(100% + 10px);top:0;height:100%;align-items:center;transform-origin:0 50%;transform:translateZ(var(--z)) rotateZ(calc(-1*var(--spin))) rotateX(calc(-1*var(--tilt)));opacity:1}
.tag button{pointer-events:auto;font:inherit;font-weight:700;font-size:var(--ft);color:var(--ink);background:var(--tag);border:2px solid var(--gray);border-radius:99px;padding:.3em .75em;cursor:pointer;white-space:nowrap;box-sizing:border-box;width:var(--tpw,auto);text-align:center}
.tag button[aria-pressed="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.tag button:focus-visible,#views button:focus-visible{outline:3px solid var(--b1);outline-offset:1px}
#views{position:absolute;top:12px;left:50%;transform:translateX(-50%);display:flex;gap:4px;padding:4px;border-radius:99px;background:var(--tag);border:2px solid var(--gray);z-index:2}
#views button{font:inherit;font-weight:700;font-size:clamp(13px,2.2vw,16px);color:var(--ink);background:none;border:0;border-radius:99px;padding:.35em 1em;cursor:pointer}
#views button[aria-pressed="true"]{background:var(--ink);color:var(--bg)}
#tip{position:absolute;left:16px;bottom:12px;max-width:64%;font-size:clamp(14px,2.6vw,20px);font-weight:700;pointer-events:none}
#tip small{display:block;color:var(--mute);font-size:clamp(11px,1.8vw,14px);font-weight:500;margin-top:2px}
#brand{position:absolute;right:16px;bottom:12px;font-size:clamp(17px,3.4vw,26px);font-weight:700;letter-spacing:-.02em;pointer-events:none}
#brand em{font-style:normal;color:#0a8cff}
body.ls #views{left:12px;top:10px;transform:none;flex-direction:column;border-radius:20px}
body.ls #views button{font-size:14px;padding:.35em .9em;text-align:left}
body.ls #tip{max-width:190px;font-size:15px}
body.ls #tip small{font-size:11px}
@media (prefers-reduced-motion:reduce){.ribbon::after{animation:none}.ribbon{transition:none}}
</style>
</head>
<body>
<div id="stage"><div id="scene"></div></div>
<div id="views" role="group" aria-label="Viewing angle"><button data-v="0" aria-pressed="true">Front</button><button data-v="1" aria-pressed="false">Side</button><button data-v="2" aria-pressed="false">Back</button></div>
<div id="tip"></div>
<div id="brand">tapestr<em>.ai</em></div>
<script>
(function(){
var ENT=['Issuer','Security','Position'],SRC=['Bloomberg','WSO','Fund Admin'],TIM=['Front Office','Middle Office','Back Office'];
var scene=document.getElementById('scene'),tip=document.getElementById('tip'),stage=document.getElementById('stage');
var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
var sel={c:0,r:1},focus=-1,tiles=[],layers=[],cols=[],rows=[],tags=[],touched=false;
function el(tag,cls,parent,html){var e=document.createElement(tag);if(cls)e.className=cls;if(html!=null)e.innerHTML=html;if(parent)parent.appendChild(e);return e}
for(var t=0;t<3;t++){
 var z='calc(var(--G)*'+(1-t)+')',L=el('div','layer',scene);L.style.setProperty('--z',z);layers.push(L);
 var g=el('div','grid',L);
 for(var r=0;r<3;r++)for(var c=0;c<3;c++){
  var b=el('button','tile',g);b.setAttribute('aria-label',ENT[r]+', '+SRC[c]+', '+TIM[t]);b.dataset.c=c;b.dataset.r=r;tiles.push(b);
 }
 var tg=el('div','lbl tag',scene);tg.style.setProperty('--z',z);
 var tb=el('button','',tg,TIM[t]);tb.setAttribute('aria-pressed','false');tb.dataset.t=t;tags.push(tb);
}
for(var i=0;i<3;i++){
 var cl=el('div','lbl col',scene,SRC[i]);cl.style.left='calc(var(--pad) + '+i+'*(var(--cw) + var(--g)))';cols.push(cl);
 var rl=el('div','lbl row',scene,ENT[i]);rl.style.top='calc(var(--pad) + '+i+'*(var(--ch) + var(--g)))';rows.push(rl);
}
var rib=el('div','ribbon',scene);
// Size everything from the real frame so labels never collide, in portrait or landscape
function layout(){
 var W=stage.clientWidth,H=stage.clientHeight,ls=W>H*1.25&&H<600;
 document.body.classList.toggle('ls',ls);
 var top=ls?8:56,bot=ls?8:74,lab=26;
 var sl=Math.max(62,Math.min(112,W*(ls?.13:.17))),sr=Math.max(82,Math.min(132,W*(ls?.15:.21)));
 var ch=Math.max(20,(H-top-bot-lab)/7.5);
 var cw=Math.min((W-sl-sr-16-ch)/3,ch*2.6);
 if(cw<ch*.85)ch=Math.max(20,cw*.95);
 var g=Math.max(5,ch*.18),pad=Math.max(7,ch*.3),Sw=3*cw+2*g+2*pad,Sh=3*ch+2*g+2*pad;
 var s=stage.style;
 s.paddingTop=(top+lab)+'px';s.paddingBottom=bot+'px';
 s.setProperty('--cw',cw+'px');s.setProperty('--ch',ch+'px');s.setProperty('--g',g+'px');s.setProperty('--pad',pad+'px');
 s.setProperty('--Sw',Sw+'px');s.setProperty('--Sh',Sh+'px');s.setProperty('--G',(Sh*.82)+'px');s.setProperty('--rw',Math.min(cw*.3,ch*.9)+'px');
 var mc=layout.mc||(layout.mc=document.createElement('canvas').getContext('2d'));
 mc.font='700 100px "Avenir Next","Century Gothic","Segoe UI",system-ui,sans-serif';
 var w=SRC.map(function(n){return mc.measureText(n).width}),fc=21;
 for(var q=0;q<2;q++)fc=Math.min(fc,(cw+g)*0.84*2*100/(w[q]+w[q+1]));
 s.setProperty('--fc',Math.max(9,fc)+'px');
 s.setProperty('--fr',Math.max(11,Math.min(21,(sl-12)/4.9))+'px');
 var tw=Math.max.apply(null,TIM.map(function(n){return mc.measureText(n).width}))/100;
 var ft=Math.max(10,Math.min(18,(sr-24)/(tw+1.5)));
 s.setProperty('--ft',ft+'px');s.setProperty('--tpw',Math.ceil(tw*ft+1.5*ft+4)+'px');
 s.setProperty('--sl',sl+'px');s.setProperty('--sr',sr+'px');
}
function render(){
 rib.style.setProperty('--col',sel.c);rib.style.setProperty('--row',sel.r);
 tiles.forEach(function(b){var c=+b.dataset.c,r=+b.dataset.r;
  b.classList.toggle('sel',c===sel.c&&r===sel.r);
  b.classList.toggle('t',(c===sel.c||r===sel.r)&&!(c===sel.c&&r===sel.r));});
 cols.forEach(function(e,i){e.classList.toggle('on',i===sel.c)});
 rows.forEach(function(e,i){e.classList.toggle('on',i===sel.r)});
 layers.forEach(function(l,i){l.classList.toggle('dim',focus>=0&&focus!==i)});
 tags.forEach(function(b,i){b.setAttribute('aria-pressed',focus===i?'true':'false')});
 tip.innerHTML=ENT[sel.r]+' &middot; '+SRC[sel.c]+(focus>=0?' &middot; '+TIM[focus]:'')+
  '<small>'+(focus>=0?'Showing '+TIM[focus]+' only. Tap it again for all three.':'The same record across the Front, Middle and Back Office.')+'</small>';
}
var vbtns=document.querySelectorAll('#views button');
var VIEWS=[[56,0],[78,-38],[128,24]],cur={t:56,s:0},justDragged=false,anim=0;
function apply(){stage.style.setProperty('--tilt',cur.t+'deg');stage.style.setProperty('--spin',cur.s+'deg')}
function mark(v){vbtns.forEach(function(b,i){b.setAttribute('aria-pressed',i===v?'true':'false')})}
function goTo(v){
 mark(v);touched=true;cancelAnimationFrame(anim);
 var to=VIEWS[v],from={t:cur.t,s:cur.s};
 if(reduce){cur={t:to[0],s:to[1]};apply();return}
 var t0=performance.now();
 (function step(now){
  var u=Math.min(1,(now-t0)/800),e=u<.5?2*u*u:1-Math.pow(-2*u+2,2)/2;
  cur.t=from.t+(to[0]-from.t)*e;cur.s=from.s+(to[1]-from.s)*e;apply();
  if(u<1)anim=requestAnimationFrame(step);
 })(t0);
}
vbtns.forEach(function(b,i){b.addEventListener('click',function(){goTo(i)})});
var down=null;
stage.addEventListener('pointerdown',function(e){if(e.target.closest('.tag'))return;down={x:e.clientX,y:e.clientY,moved:false}});
window.addEventListener('pointermove',function(e){
 if(!down)return;var dx=e.clientX-down.x,dy=e.clientY-down.y;
 if(!down.moved&&Math.abs(dx)+Math.abs(dy)<6)return;
 if(!down.moved){down.moved=true;cancelAnimationFrame(anim);stage.classList.add('drag');mark(-1);touched=true}
 down.x=e.clientX;down.y=e.clientY;
 cur.s+=dx*0.4;cur.t=Math.max(15,Math.min(165,cur.t+dy*0.3));apply();
});
window.addEventListener('pointerup',function(){
 if(down&&down.moved){justDragged=true;setTimeout(function(){justDragged=false},0)}
 down=null;stage.classList.remove('drag');
});
scene.addEventListener('click',function(e){
 if(justDragged)return;
 var b=e.target.closest('button');if(!b)return;touched=true;
 if(b.dataset.t!==undefined){var n=+b.dataset.t;focus=focus===n?-1:n}
 else{sel={c:+b.dataset.c,r:+b.dataset.r}}
 render();
});
window.addEventListener('resize',layout);
try{new ResizeObserver(layout).observe(stage)}catch(e){}
layout();apply();render();
if(!reduce){
 var path=[[1,1],[0,0],[2,1],[1,2],[2,0],[0,2]],k=0;
 setInterval(function(){if(touched)return;k=(k+1)%path.length;sel={c:path[k][0],r:path[k][1]};render()},3600);
}
})();
</script>
</body>
</html>`;
