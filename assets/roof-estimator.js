/* Crockett Construction roof estimator - no Google account or API key required */
const CONFIG = Object.freeze({
    PRICE_PER_SQUARE: Object.freeze({ low: 570, high: 675 }),
    WASTE_PCT: 0.15,
    FORM_ENDPOINT: "https://formspree.io/f/mgegprnp",
    MAP_CENTER: Object.freeze([40.589, -83.128]),
    AUTO_FIND_RADIUS_METERS: 60,
    MAX_BUILDING_DISTANCE_METERS: 55,
    GEOCODER_URL: "https://nominatim.openstreetmap.org/search",
    OVERPASS_URLS: Object.freeze([
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter"
    ])
});

let map;
let selectedAddress = null;
let addressMarker = null;
let currentPolygon = null;
let candidateLayers = [];
let selectedCandidate = null;
let drawClickHandler = null;
let drawingPoints = [];
let drawingLine = null;
let drawingMarkers = [];
let isDrawing = false;
let isSubmitting = false;
let lastSubmissionKey = "";

const byId = (id) => document.getElementById(id);

function initEstimator() {
    map = L.map("map", { zoomControl: true }).setView(CONFIG.MAP_CENTER, 14);

    const imagery = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        {
            maxZoom: 20,
            attribution: "Tiles &copy; Esri and imagery contributors"
        }
    ).addTo(map);

    const streets = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors"
    });

    L.control.layers({ "Satellite": imagery, "Street map": streets }, null, {
        position: "topright",
        collapsed: true
    }).addTo(map);

    byId("findAddressBtn").addEventListener("click", findProperty);
    byId("address").addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            findProperty();
        }
    });
    byId("address").addEventListener("input", handleAddressEdited);
    byId("slopeRange").addEventListener("input", handleSlopeChanged);
    byId("autoFootprintBtn").addEventListener("click", searchForBuildingOutlines);
    byId("drawRoofBtn").addEventListener("click", toggleDrawing);
    byId("clearBtn").addEventListener("click", clearOutline);
    byId("estimateBtn").addEventListener("click", calculateAndSubmit);
    byId("phone").addEventListener("input", formatPhoneNumber);

    ["fullName", "email", "phone"].forEach((id) => {
        byId(id).addEventListener("input", () => {
            clearInvalid(byId(id));
            lastSubmissionKey = "";
        });
    });
}

window.addEventListener("load", () => {
    if (!window.L) {
        showStatus("The map library could not load. Please refresh the page or call Crockett Construction for an estimate.", "error");
        return;
    }
    initEstimator();
});

function handleAddressEdited() {
    selectedAddress = null;
    lastSubmissionKey = "";
    clearInvalid(byId("address"));
}

function handleSlopeChanged() {
    byId("slopeValue").textContent = `${byId("slopeRange").value}/12`;
    lastSubmissionKey = "";
    updateCalculations();
}

async function findProperty() {
    const query = byId("address").value.trim();
    if (query.length < 6) {
        markInvalid(byId("address"));
        showStatus("Enter the complete property address, including the city and state.", "error");
        return;
    }

    setBusy(byId("findAddressBtn"), true, "Finding...");
    showStatus("Finding the property address...", "info");

    try {
        const parameters = new URLSearchParams({
            format: "jsonv2",
            q: query,
            countrycodes: "us",
            limit: "5",
            addressdetails: "1",
            polygon_geojson: "1"
        });
        const response = await fetchWithTimeout(`${CONFIG.GEOCODER_URL}?${parameters}`, {}, 12000);
        if (!response.ok) throw new Error(`Address service returned ${response.status}`);
        const results = await response.json();
        const result = chooseBestAddressResult(results, query);
        if (!result) throw new Error("No matching address was found");

        selectedAddress = normalizeAddressResult(result);
        byId("address").value = selectedAddress.displayName;
        clearInvalid(byId("address"));
        lastSubmissionKey = "";

        const location = [selectedAddress.lat, selectedAddress.lng];
        map.setView(location, 20);
        if (addressMarker) map.removeLayer(addressMarker);
        addressMarker = L.circleMarker(location, {
            radius: 5,
            color: "#fff",
            weight: 2,
            fillColor: "#292929",
            fillOpacity: 1
        }).addTo(map).bindTooltip("Address location");

        setPolygon(null);
        await searchForBuildingOutlines(result);
    } catch (error) {
        console.warn("Address search failed:", error);
        selectedAddress = null;
        markInvalid(byId("address"));
        showStatus("That address could not be located. Check the spelling and include the city, state, and ZIP code.", "error");
    } finally {
        setBusy(byId("findAddressBtn"), false, "Find Property");
    }
}

function chooseBestAddressResult(results, originalQuery) {
    if (!Array.isArray(results) || !results.length) return null;
    const requestedNumber = extractHouseNumber(originalQuery);
    const eligibleResults = requestedNumber
        ? results.filter((result) => normalizeText(result.address?.house_number) === normalizeText(requestedNumber))
        : results;
    if (!eligibleResults.length) return null;
    return [...eligibleResults].sort((a, b) => addressResultScore(b, requestedNumber) - addressResultScore(a, requestedNumber))[0];
}

function addressResultScore(result, requestedNumber) {
    let score = 0;
    const address = result.address || {};
    if (requestedNumber && normalizeText(address.house_number) === normalizeText(requestedNumber)) score += 500;
    if (["house", "building"].includes(result.type)) score += 150;
    if (result.geojson?.type === "Polygon" || result.geojson?.type === "MultiPolygon") score += 200;
    if (address.road) score += 50;
    return score + Number(result.importance || 0);
}

function normalizeAddressResult(result) {
    return {
        lat: Number(result.lat),
        lng: Number(result.lon),
        displayName: result.display_name,
        osmType: result.osm_type || "",
        osmId: result.osm_id || "",
        address: result.address || {},
        geojson: result.geojson || null
    };
}

async function searchForBuildingOutlines(geocoderResult = null) {
    if (!selectedAddress) {
        markInvalid(byId("address"));
        showStatus("Find the property address before searching for a roof outline.", "error");
        return;
    }

    stopDrawing();
    clearCandidates();
    setPolygon(null);
    const button = byId("autoFootprintBtn");
    setBusy(button, true, "Searching...");
    showStatus("Checking available building outlines near this address...", "info");

    try {
        const candidates = [];
        const directGeometry = geocoderResult?.geojson || selectedAddress.geojson;
        candidates.push(...geoJsonToCandidates(directGeometry, {
            source: "address",
            tags: selectedAddress.address
        }));

        const overpassCandidates = await fetchOverpassBuildings(selectedAddress.lat, selectedAddress.lng);
        candidates.push(...overpassCandidates);
        const uniqueCandidates = deduplicateCandidates(candidates)
            .map((candidate) => ({ ...candidate, score: scoreBuilding(candidate) }))
            .filter((candidate) => candidate.distance <= CONFIG.MAX_BUILDING_DISTANCE_METERS)
            .sort((a, b) => b.score - a.score);

        if (!uniqueCandidates.length) {
            showStatus("No reliable building outline was found here. Use Draw Roof and click the outside roof corners on the satellite image.", "info");
            return;
        }

        displayCandidates(uniqueCandidates);
        selectCandidate(uniqueCandidates[0]);

        if (uniqueCandidates.length === 1) {
            showStatus("One building outline was found. Verify the orange outline before calculating.", "success");
        } else {
            showStatus(`${uniqueCandidates.length} nearby building outlines were found. The best match is orange; click a gray building if another one is correct.`, "success");
        }
    } catch (error) {
        console.warn("Building outline search failed:", error);
        showStatus("Automatic outlines are unavailable right now. Use Draw Roof and trace the roof on the satellite image.", "info");
    } finally {
        setBusy(button, false, "Search Again");
    }
}

async function fetchOverpassBuildings(lat, lng) {
    const query = `[out:json][timeout:20];(way(around:${CONFIG.AUTO_FIND_RADIUS_METERS},${lat},${lng})["building"];relation(around:${CONFIG.AUTO_FIND_RADIUS_METERS},${lat},${lng})["building"];);out tags geom;`;
    let lastError = null;

    for (const endpoint of CONFIG.OVERPASS_URLS) {
        try {
            const response = await fetchWithTimeout(`${endpoint}?data=${encodeURIComponent(query)}`, {}, 15000);
            if (!response.ok) throw new Error(`Outline service returned ${response.status}`);
            return overpassToCandidates(await response.json());
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error("No outline service responded");
}

function overpassToCandidates(data) {
    const candidates = [];
    for (const element of data.elements || []) {
        if (element.type === "way" && Array.isArray(element.geometry)) {
            const path = element.geometry.map((point) => [point.lat, point.lon]);
            if (path.length >= 3) candidates.push(makeCandidate(path, element.tags || {}, `way-${element.id}`));
        }

        if (element.type === "relation" && Array.isArray(element.members)) {
            for (const member of element.members) {
                if (member.role !== "outer" || !Array.isArray(member.geometry)) continue;
                const path = member.geometry.map((point) => [point.lat, point.lon]);
                if (path.length >= 3) candidates.push(makeCandidate(path, element.tags || {}, `relation-${element.id}`));
            }
        }
    }
    return candidates;
}

function geoJsonToCandidates(geojson, metadata = {}) {
    if (!geojson) return [];
    const paths = [];
    if (geojson.type === "Polygon") paths.push(...geojson.coordinates.slice(0, 1));
    if (geojson.type === "MultiPolygon") {
        geojson.coordinates.forEach((polygon) => paths.push(...polygon.slice(0, 1)));
    }
    return paths
        .map((coordinates) => coordinates.map(([lng, lat]) => [lat, lng]))
        .filter((path) => path.length >= 3)
        .map((path, index) => makeCandidate(path, metadata.tags || {}, `${metadata.source || "geojson"}-${index}`));
}

function makeCandidate(path, tags, id) {
    const cleanPath = removeDuplicateClosingPoint(path);
    const center = polygonCenter(cleanPath);
    return {
        id,
        path: cleanPath,
        tags,
        center,
        distance: distanceMeters([selectedAddress.lat, selectedAddress.lng], center),
        areaSqft: calculateAreaSqft(cleanPath)
    };
}

function scoreBuilding(candidate) {
    const target = [selectedAddress.lat, selectedAddress.lng];
    const requestedNumber = normalizeText(selectedAddress.address.house_number || extractHouseNumber(byId("address").value));
    const requestedRoad = normalizeText(selectedAddress.address.road || selectedAddress.address.street);
    const candidateNumber = normalizeText(candidate.tags["addr:housenumber"] || candidate.tags.house_number);
    const candidateRoad = normalizeText(candidate.tags["addr:street"] || candidate.tags.road);
    const buildingType = normalizeText(candidate.tags.building);
    let score = 0;

    if (pointInPolygon(target, candidate.path)) score += 1200;
    if (requestedNumber && candidateNumber === requestedNumber) score += 600;
    if (requestedRoad && candidateRoad && stringsSimilar(requestedRoad, candidateRoad)) score += 300;
    if (candidate.id.startsWith("address-")) score += 250;
    if (["house", "residential", "detached", "yes"].includes(buildingType)) score += 100;
    if (["garage", "garages", "shed", "carport", "barn"].includes(buildingType)) score -= 300;
    if (candidate.areaSqft >= 500 && candidate.areaSqft <= 15000) score += 100;
    if (candidate.areaSqft < 200 || candidate.areaSqft > 30000) score -= 400;
    score -= candidate.distance * 4;
    return score;
}

function deduplicateCandidates(candidates) {
    const kept = [];
    for (const candidate of candidates) {
        const duplicate = kept.some((existing) =>
            distanceMeters(candidate.center, existing.center) < 2 &&
            Math.abs(candidate.areaSqft - existing.areaSqft) < Math.max(50, existing.areaSqft * 0.05)
        );
        if (!duplicate) kept.push(candidate);
    }
    return kept;
}

function displayCandidates(candidates) {
    clearCandidates();
    candidates.slice(0, 12).forEach((candidate) => {
        const layer = L.polygon(candidate.path, candidateStyle(false)).addTo(map);
        layer.on("click", () => selectCandidate(candidate));
        layer.bindTooltip("Click to select this building", { sticky: true });
        candidate.layer = layer;
        candidateLayers.push(layer);
    });
}

function selectCandidate(candidate) {
    selectedCandidate = candidate;
    candidateLayers.forEach((layer) => layer.setStyle(candidateStyle(false)));
    candidate.layer?.setStyle(candidateStyle(true));
    setPolygon(L.polygon(candidate.path, selectedStyle()).addTo(map), false);
    map.fitBounds(currentPolygon.getBounds(), { padding: [35, 35], maxZoom: 20 });
    lastSubmissionKey = "";
}

function candidateStyle(selected) {
    return {
        color: selected ? "#f36f21" : "#5b6470",
        weight: selected ? 3 : 2,
        fillColor: selected ? "#f36f21" : "#aeb4bb",
        fillOpacity: selected ? 0.18 : 0.12
    };
}

function selectedStyle() {
    return { color: "#f36f21", weight: 4, fillColor: "#f36f21", fillOpacity: 0.28 };
}

function clearCandidates() {
    candidateLayers.forEach((layer) => map.removeLayer(layer));
    candidateLayers = [];
    selectedCandidate = null;
}

function toggleDrawing() {
    if (isDrawing) finishDrawing();
    else startDrawing();
}

function startDrawing() {
    if (!selectedAddress) {
        markInvalid(byId("address"));
        showStatus("Find the property address before drawing the roof.", "error");
        return;
    }

    clearCandidates();
    setPolygon(null);
    drawingPoints = [];
    isDrawing = true;
    map.getContainer().style.cursor = "crosshair";
    byId("drawRoofBtn").textContent = "Finish Outline";
    byId("drawRoofBtn").classList.remove("secondary");
    showStatus("Click each outside roof corner. After at least three points, click Finish Outline.", "info");

    drawClickHandler = (event) => {
        drawingPoints.push([event.latlng.lat, event.latlng.lng]);
        const marker = L.circleMarker(event.latlng, {
            radius: 4,
            color: "#fff",
            weight: 2,
            fillColor: "#f36f21",
            fillOpacity: 1
        }).addTo(map);
        drawingMarkers.push(marker);

        if (drawingLine) map.removeLayer(drawingLine);
        drawingLine = L.polyline(drawingPoints, { color: "#f36f21", weight: 3 }).addTo(map);
        if (drawingPoints.length >= 3) {
            showStatus(`${drawingPoints.length} corners added. Continue or click Finish Outline.`, "info");
        }
    };
    map.on("click", drawClickHandler);
}

function finishDrawing() {
    if (drawingPoints.length < 3) {
        showStatus("Add at least three roof corners before finishing the outline.", "error");
        return;
    }
    const path = [...drawingPoints];
    stopDrawing();
    setPolygon(L.polygon(path, selectedStyle()).addTo(map));
    showStatus("Manual roof outline added. Clear and redraw it if any corners are incorrect.", "success");
}

function stopDrawing() {
    if (drawClickHandler) map.off("click", drawClickHandler);
    drawClickHandler = null;
    if (drawingLine) map.removeLayer(drawingLine);
    drawingLine = null;
    drawingMarkers.forEach((marker) => map.removeLayer(marker));
    drawingMarkers = [];
    drawingPoints = [];
    isDrawing = false;
    if (map) map.getContainer().style.cursor = "";
    if (byId("drawRoofBtn")) {
        byId("drawRoofBtn").textContent = "Draw Roof";
        byId("drawRoofBtn").classList.add("secondary");
    }
}

function clearOutline() {
    stopDrawing();
    clearCandidates();
    setPolygon(null);
    hideStatus();
}

function setPolygon(polygon, removeCandidates = true) {
    if (currentPolygon && map.hasLayer(currentPolygon)) map.removeLayer(currentPolygon);
    currentPolygon = polygon;
    if (removeCandidates) selectedCandidate = null;
    lastSubmissionKey = "";
    updateCalculations();
}

function getPolygonPath(polygon) {
    if (!polygon) return [];
    const latLngs = polygon.getLatLngs();
    const firstRing = Array.isArray(latLngs[0]) ? latLngs[0] : latLngs;
    return firstRing.map((point) => [point.lat, point.lng]);
}

function calculateAreaSqft(path) {
    if (!path || path.length < 3) return 0;
    const points = path.map(([lat, lng]) => L.CRS.EPSG3857.project(L.latLng(lat, lng)));
    let area = 0;
    for (let index = 0; index < points.length; index += 1) {
        const current = points[index];
        const next = points[(index + 1) % points.length];
        area += current.x * next.y - next.x * current.y;
    }
    const latitude = path.reduce((sum, point) => sum + point[0], 0) / path.length;
    const mercatorCorrection = Math.pow(Math.cos(latitude * Math.PI / 180), 2);
    return Math.abs(area / 2) * mercatorCorrection * 10.7639;
}

function getSlopeFactor(risePer12) {
    const rise = Number(risePer12) || 0;
    return Math.sqrt(1 + Math.pow(rise / 12, 2));
}

function getMeasurements() {
    const footprintSqft = calculateAreaSqft(getPolygonPath(currentPolygon));
    const slope = Number(byId("slopeRange").value);
    const slopeFactor = getSlopeFactor(slope);
    const orderSqft = footprintSqft * slopeFactor * (1 + CONFIG.WASTE_PCT);
    return { footprintSqft, slope, slopeFactor, orderSqft, roofingSquares: orderSqft / 100 };
}

function updateCalculations() {
    // Measurements remain internal and are only used to calculate the estimate.
}

function computeEstimate() {
    const measurements = getMeasurements();
    if (measurements.footprintSqft <= 0) return null;
    const priceLow = Math.ceil((measurements.roofingSquares * CONFIG.PRICE_PER_SQUARE.low) / 100) * 100;
    const priceHigh = Math.ceil((measurements.roofingSquares * CONFIG.PRICE_PER_SQUARE.high) / 100) * 100;
    return {
        address: selectedAddress.displayName,
        roofType: "Architectural shingles",
        slope: `${measurements.slope}/12`,
        footprintSqft: measurements.footprintSqft,
        orderSqft: measurements.orderSqft,
        roofingSquares: measurements.roofingSquares,
        wastePct: CONFIG.WASTE_PCT,
        pricePerSquareLow: CONFIG.PRICE_PER_SQUARE.low,
        pricePerSquareHigh: CONFIG.PRICE_PER_SQUARE.high,
        priceLow,
        priceHigh,
        outlineSource: selectedCandidate ? "OpenStreetMap building footprint" : "Customer-drawn outline"
    };
}

async function calculateAndSubmit() {
    if (isSubmitting) return;
    const validation = validateRequiredInformation();
    if (!validation.ok) {
        showStatus(validation.message, "error");
        validation.element?.focus();
        validation.element?.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
    }

    const estimate = computeEstimate();
    if (!estimate) {
        showStatus("Select or draw the roof outline before calculating the price.", "error");
        byId("map").scrollIntoView({ behavior: "smooth", block: "center" });
        return;
    }

    renderEstimate(estimate);
    const payload = buildSubmission(estimate);
    const submissionKey = JSON.stringify(payload);
    if (submissionKey === lastSubmissionKey) {
        showStatus("Your estimate is displayed below and was already sent to Crockett Construction.", "success");
        return;
    }

    isSubmitting = true;
    setBusy(byId("estimateBtn"), true, "Sending...");
    try {
        await sendToFormspree(payload);
        lastSubmissionKey = submissionKey;
        showStatus("Your estimate is ready and your information was sent to Crockett Construction.", "success");
    } catch (error) {
        console.error("Estimate submission failed:", error);
        showStatus("Your price is displayed, but your information could not be sent. Please call Crockett Construction to follow up.", "error");
    } finally {
        isSubmitting = false;
        setBusy(byId("estimateBtn"), false, "Recalculate My Price");
    }
}

function validateRequiredInformation() {
    if (!selectedAddress) {
        markInvalid(byId("address"));
        return { ok: false, message: "Find and verify the complete property address first.", element: byId("address") };
    }
    const name = byId("fullName").value.trim();
    if (name.length < 3) {
        markInvalid(byId("fullName"));
        return { ok: false, message: "Enter your full name to view the estimate.", element: byId("fullName") };
    }
    const email = byId("email").value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        markInvalid(byId("email"));
        return { ok: false, message: "Enter a valid email address to view the estimate.", element: byId("email") };
    }
    const phoneDigits = byId("phone").value.replace(/\D/g, "");
    if (phoneDigits.length !== 10) {
        markInvalid(byId("phone"));
        return { ok: false, message: "Enter a valid 10-digit phone number to view the estimate.", element: byId("phone") };
    }
    return { ok: true };
}

function renderEstimate(estimate) {
    const money = (amount) => amount.toLocaleString("en-US", {
        style: "currency", currency: "USD", maximumFractionDigits: 0
    });
    byId("estimateBox").innerHTML = `
        <div class="estimator-price-row">
            <div class="estimator-price-card">
                <h3>Estimated Low</h3>
                <div class="estimator-price">${money(estimate.priceLow)}</div>
            </div>
            <div class="estimator-price-card">
                <h3>Estimated High</h3>
                <div class="estimator-price">${money(estimate.priceHigh)}</div>
            </div>
        </div>`;
}

function buildSubmission(estimate) {
    return {
        timestamp: new Date().toISOString(),
        name: byId("fullName").value.trim(),
        email: byId("email").value.trim(),
        phone: byId("phone").value.trim(),
        address: estimate.address,
        roofType: estimate.roofType,
        slope: estimate.slope,
        footprintSqft: Math.round(estimate.footprintSqft),
        estimatedOrderSqft: Math.round(estimate.orderSqft),
        estimatedRoofingSquares: Number(estimate.roofingSquares.toFixed(1)),
        wastePercent: Math.round(estimate.wastePct * 100),
        pricePerSquare: `$${estimate.pricePerSquareLow}-$${estimate.pricePerSquareHigh}`,
        estimatedPrice: `$${Math.round(estimate.priceLow).toLocaleString()}-$${Math.round(estimate.priceHigh).toLocaleString()}`,
        outlineSource: estimate.outlineSource,
        osmReference: selectedAddress.osmType && selectedAddress.osmId
            ? `${selectedAddress.osmType}/${selectedAddress.osmId}`
            : ""
    };
}

async function sendToFormspree(payload) {
    const formData = new FormData();
    Object.entries(payload).forEach(([key, value]) => formData.append(key, String(value)));
    formData.append("_subject", `New Roof Estimate - ${payload.address}`);
    const response = await fetch(CONFIG.FORM_ENDPOINT, {
        method: "POST", body: formData, headers: { Accept: "application/json" }
    });
    if (!response.ok) {
        const details = await response.json().catch(() => ({}));
        throw new Error(details.error || `Form service returned ${response.status}`);
    }
}

function removeDuplicateClosingPoint(path) {
    if (path.length < 2) return path;
    const first = path[0];
    const last = path[path.length - 1];
    return first[0] === last[0] && first[1] === last[1] ? path.slice(0, -1) : path;
}

function polygonCenter(path) {
    const bounds = L.latLngBounds(path.map(([lat, lng]) => L.latLng(lat, lng)));
    const center = bounds.getCenter();
    return [center.lat, center.lng];
}

function pointInPolygon(point, path) {
    const [y, x] = point;
    let inside = false;
    for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
        const [yi, xi] = path[i];
        const [yj, xj] = path[j];
        const intersects = ((yi > y) !== (yj > y)) &&
            (x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi);
        if (intersects) inside = !inside;
    }
    return inside;
}

function distanceMeters(a, b) {
    const earthRadius = 6371000;
    const lat1 = a[0] * Math.PI / 180;
    const lat2 = b[0] * Math.PI / 180;
    const deltaLat = (b[0] - a[0]) * Math.PI / 180;
    const deltaLng = (b[1] - a[1]) * Math.PI / 180;
    const h = Math.sin(deltaLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
    return earthRadius * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function extractHouseNumber(text) {
    return String(text || "").trim().match(/^\d+[A-Za-z-]*/)?.[0] || "";
}

function normalizeText(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stringsSimilar(a, b) {
    return a === b || a.includes(b) || b.includes(a);
}

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        window.clearTimeout(timeout);
    }
}

function formatPhoneNumber(event) {
    const digits = event.target.value.replace(/\D/g, "").slice(0, 10);
    if (digits.length <= 3) event.target.value = digits;
    else if (digits.length <= 6) event.target.value = `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    else event.target.value = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function markInvalid(element) {
    element.classList.add("is-invalid");
    element.setAttribute("aria-invalid", "true");
}

function clearInvalid(element) {
    element.classList.remove("is-invalid");
    element.removeAttribute("aria-invalid");
}

function setBusy(button, busy, label) {
    button.disabled = busy;
    button.textContent = label;
}

function showStatus(message, type) {
    const status = byId("estimatorStatus");
    status.textContent = message;
    status.className = `estimator-status ${type}`;
    status.hidden = false;
}

function hideStatus() {
    const status = byId("estimatorStatus");
    status.hidden = true;
    status.textContent = "";
}
