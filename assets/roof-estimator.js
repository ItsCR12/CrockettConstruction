/* Roof Estimator Front-End (GitHub Pages compatible) */
const CONFIG = {
  COSTS: { shingle: { min: 3.25, max: 5.00 }, metal: { min: 7.50, max: 12.00 } },
  WASTE_PCT: 0.15, PROFIT_MIN: 0.40, PROFIT_MAX: 0.50,
  EMAIL: {
    mode: "formspree", // "formspree" | "emailjs" | "mailto"
    formspree_endpoint: "https://formspree.io/f/mgegprnp", // <-- your endpoint
    emailjs: { service_id: "", template_id: "", public_key: "" },
    to: "crockettgavyn12@gmail.com"
  }
};

let map, autocomplete, drawingManager, currentPolygon = null, placeMarker = null;
function $(id){ return document.getElementById(id); }

function initEstimator() {
  map = new google.maps.Map($("map"), { center:{lat:40.589,lng:-83.128}, zoom:14, mapTypeId:"hybrid", tilt:0 });

  autocomplete = new google.maps.places.Autocomplete($("address"), {
    fields:["geometry","formatted_address","place_id","name"],
    componentRestrictions:{country:"us"}
  });

  autocomplete.addListener("place_changed", async () => {
    const place = autocomplete.getPlace();
    if(!place.geometry || !place.geometry.location) return;

    map.fitBounds(place.geometry.viewport || new google.maps.LatLngBounds(place.geometry.location, place.geometry.location));
    map.setZoom(19);

    if (placeMarker) placeMarker.setMap(null);
    placeMarker = new google.maps.Marker({
      map, position: place.geometry.location,
      title: place.formatted_address || place.name || "Selected location"
    });

    setPolygon(null);
    tryAutoFootprint(place.geometry.location);
  });

  drawingManager = new google.maps.drawing.DrawingManager({
    drawingControl:false,
    polygonOptions:{
      fillColor:"#4caf50", fillOpacity:0.25,
      strokeColor:"#4caf50", strokeOpacity:0.9, strokeWeight:2,
      clickable:false, editable:true
    }
  });
  drawingManager.setMap(map);
  google.maps.event.addListener(drawingManager, "polygoncomplete", function(p){
    setPolygon(p); drawingManager.setDrawingMode(null);
  });

  $("slopeRange").addEventListener("input", () => {
    $("slopeValue").textContent = `${$("slopeRange").value}/12`;
    updateCalculations();
  });

  $("autoFootprintBtn").addEventListener("click", async () => {
    const place = autocomplete.getPlace();
    if(!place || !place.geometry){
      alert("Enter an address first (use suggestions).");
      return;
    }
    tryAutoFootprint(place.geometry.location, true);
  });

  $("drawRoofBtn").addEventListener("click", () => {
    drawingManager.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
  });

  $("clearBtn").addEventListener("click", () => { setPolygon(null); });

  $("estimateBtn").addEventListener("click", () => {
    const est = computeEstimate();
    if(!est){
      alert("Select an address and outline the roof (or use Auto-Find).");
      return;
    }
    renderEstimate(est);
    autoSendEstimate(est); // <-- automatically email after calculating
  });
}

window.addEventListener("load", () => {
  if (!window.google || !google.maps || !google.maps.geometry) { return; }
  initEstimator();
});

function setPolygon(poly){ if(currentPolygon) currentPolygon.setMap(null); currentPolygon = poly; updateCalculations(); }

async function tryAutoFootprint(latLng, zoomTo=false){
  const lat=latLng.lat(), lng=latLng.lng(), radius=60;
  const q = `[out:json][timeout:25];(way(around:${radius},${lat},${lng})["building"];relation(around:${radius},${lat},${lng})["building"];);out body;>;out skel qt;`;
  const url="https://overpass-api.de/api/interpreter?data="+encodeURIComponent(q);

  try {
    const resp = await fetch(url);
    if(!resp.ok) throw new Error("Overpass unavailable");
    const data = await resp.json();
    const poly = overpassToLargestPolygon(data);
    if (poly && poly.length>=3){
      const gPoly = new google.maps.Polygon({
        paths:poly, map,
        fillColor:"#4caf50", fillOpacity:0.25,
        strokeColor:"#4caf50", strokeOpacity:0.9, strokeWeight:2,
        clickable:false, editable:true
      });
      setPolygon(gPoly);
      if(zoomTo) zoomToPolygon(gPoly);
    } else {
      alert("Couldn’t auto-detect a building outline here. Use Draw Roof to trace it.");
    }
  } catch(e){
    console.warn("Overpass error:", e);
    alert("Auto-detect not available. Use Draw Roof to trace the roof.");
  }
}

function overpassToLargestPolygon(data){
  const nodes=new Map();
  for(const el of data.elements){ if(el.type==="node") nodes.set(el.id,{lat:el.lat,lng:el.lon}); }
  const polys=[];
  for(const el of data.elements){
    if(el.type==="way" && el.nodes && el.nodes.length>=4){
      const first=el.nodes[0], last=el.nodes[el.nodes.length-1];
      if(first===last){
        const path=el.nodes.map(n=>nodes.get(n)).filter(Boolean);
        if(path.length>=3) polys.push(path);
      }
    } else if(el.type==="relation" && el.tags && el.tags.type==="multipolygon"){
      const outers=el.members?.filter(m=>m.role==="outer" && m.type==="way")||[];
      let combined=[];
      for(const m of outers){
        const way=data.elements.find(x=>x.type==="way"&&x.id===m.ref);
        if(way && way.nodes){
          const path=way.nodes.map(n=>nodes.get(n)).filter(Boolean);
          combined=combined.concat(path);
        }
      }
      if(combined.length>=3) polys.push(combined);
    }
  }
  if(!polys.length) return null;
  let best=null,bestArea=0;
  for(const path of polys){
    const area = google.maps.geometry.spherical.computeArea(path.map(p=>new google.maps.LatLng(p.lat,p.lng)));
    if(area>bestArea){ bestArea=area; best=path; }
  }
  return best;
}

function zoomToPolygon(poly){
  const b=new google.maps.LatLngBounds();
  poly.getPath().forEach(p=>b.extend(p));
  map.fitBounds(b);
}

function getPolygonAreaSqft(poly){
  if(!poly) return 0;
  const path=poly.getPath().getArray();
  if(path.length<3) return 0;
  const m2=google.maps.geometry.spherical.computeArea(path);
  return m2*10.7639;
}

function getSlopeFactor(rp12){ const r=Number(rp12)||0; return Math.sqrt(1+(r/12)*(r/12)); }

function updateCalculations(){
  const fp=getPolygonAreaSqft(currentPolygon);
  const slope=Number($("slopeRange").value);
  const slopeFactor=getSlopeFactor(slope);
  const waste=CONFIG.WASTE_PCT;

  if(fp>0){
    const surface=fp*slopeFactor*(1+waste);
    $("footprintSqft").textContent=fp.toFixed(0);
    $("slopeFactor").textContent=slopeFactor.toFixed(3);
    $("surfaceSqft").textContent=surface.toFixed(0);
    $("calcResults").style.display="block";
  } else {
    $("calcResults").style.display="none";
  }
}

function computeEstimate(){
  const fp=getPolygonAreaSqft(currentPolygon);
  if(fp<=0) return null;

  const slope=Number($("slopeRange").value);
  const slopeFactor=getSlopeFactor(slope);
  const type=(document.querySelector('input[name="roofType"]:checked')?.value||"shingle");

  const surface=fp*slopeFactor*(1+CONFIG.WASTE_PCT);
  const costs=CONFIG.COSTS[type];
  const baseMin=costs.min*surface, baseMax=costs.max*surface;
  const priceLow=baseMin*(1+CONFIG.PROFIT_MIN), priceHigh=baseMax*(1+CONFIG.PROFIT_MAX);

  return {
    address:$("address").value.trim(),
    roofType:type,
    slope:`${slope}/12`,
    slopeFactor,
    footprintSqft:fp,
    surfaceSqft:surface,
    wastePct:CONFIG.WASTE_PCT,
    priceLow, priceHigh,
    costsUsed:{typeMin:costs.min, typeMax:costs.max}
  };
}

/* Removed the "based on ..." text below prices */
function renderEstimate(est){
  const money=(n)=>n.toLocaleString(undefined,{style:"currency",currency:"USD",maximumFractionDigits:0});
  $("estimateBox").innerHTML = `
    <div class="estimator-price-row">
      <div class="estimator-price-card">
        <h4>Low Estimate</h4>
        <div class="estimator-price">${money(est.priceLow)}</div>
      </div>
      <div class="estimator-price-card">
        <h4>High Estimate</h4>
        <div class="estimator-price">${money(est.priceHigh)}</div>
      </div>
    </div>
  `;
}

function buildEmailPayload(est){
  return {
    timestamp:new Date().toISOString(),
    address:est.address,
    roofType:est.roofType,
    slope:est.slope,
    slopeFactor:est.slopeFactor,
    footprintSqft:Math.round(est.footprintSqft),
    surfaceSqft:Math.round(est.surfaceSqft),
    wastePct:Math.round(CONFIG.WASTE_PCT*100),
    priceLow:Math.round(est.priceLow),
    priceHigh:Math.round(est.priceHigh),
    costsUsed:est.costsUsed,
    contact:{
      name:$("fullName").value.trim(),
      email:$("email").value.trim(),
      phone:$("phone").value.trim()
    },
    place:(window.autocomplete && autocomplete.getPlace())
      ? { place_id:autocomplete.getPlace().place_id||null, formatted_address:autocomplete.getPlace().formatted_address||null }
      : null
  };
}

/* Automatically send via Formspree after calculation */
async function autoSendEstimate(est){
  const payload = buildEmailPayload(est);
  try {
    const res = await sendEstimateStatic(payload);
    if (res.ok) {
      console.log("Auto-email sent successfully via Formspree.");
    } else {
      console.warn("Auto-email failed:", res.error || res);
    }
  } catch (e) {
    console.error("Network error while auto-emailing:", e);
  }
}

/* Static-friendly email sender */
async function sendEstimateStatic(payload){
  const mode=CONFIG.EMAIL.mode;

  if(mode==="formspree"){
    const ep=CONFIG.EMAIL.formspree_endpoint;
    if(!ep) return {ok:false,error:"Formspree endpoint not set."};

    const fd=new FormData();
    for(const[ k,v ] of Object.entries(payload)){
      fd.append(k, typeof v==="object" ? JSON.stringify(v,null,2) : String(v));
    }
    fd.append("_subject", `New Roof Estimator Submission - ${payload.address}`);

    return fetch(ep, {
      method:"POST",
      body:fd,
      headers:{ "Accept":"application/json" }
    }).then(r=>r.ok?{ok:true}:{ok:false,error:"Formspree non-200"});
  }

  if(mode==="emailjs"){
    const {service_id,template_id,public_key}=CONFIG.EMAIL.emailjs;
    if(!service_id||!template_id||!public_key) return {ok:false,error:"EmailJS keys not set."};
    await loadEmailJSSDK();
    // eslint-disable-next-line no-undef
    emailjs.init({ publicKey: public_key });
    const params={ message:JSON.stringify(payload,null,2), address:payload.address };
    try{
      // eslint-disable-next-line no-undef
      await emailjs.send(service_id, template_id, params);
      return {ok:true};
    } catch(e){
      return {ok:false,error:e?.message||e};
    }
  }

  if(mode==="mailto"){
    const to=CONFIG.EMAIL.to||"";
    if(!to) return {ok:false,error:"No mailto recipient set."};
    const subject=encodeURIComponent(`New Roof Estimator Submission - ${payload.address}`);
    const body=encodeURIComponent(JSON.stringify(payload,null,2));
    window.location.href=`mailto:${to}?subject=${subject}&body=${body}`;
    return {ok:true};
  }

  return {ok:false,error:"Unknown EMAIL.mode"};
}

function loadEmailJSSDK(){
  return new Promise((res,rej)=>{
    if(window.emailjs) return res();
    const s=document.createElement("script");
    s.src="https://cdn.jsdelivr.net/npm/@emailjs/browser@3/dist/email.min.js";
    s.onload=res;
    s.onerror=()=>rej(new Error("Failed to load EmailJS SDK"));
    document.head.appendChild(s);
  });
}
