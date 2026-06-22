/* Crockett Construction roof estimator - GitHub Pages compatible */
const CONFIG = Object.freeze({
    PRICE_PER_SQUARE: Object.freeze({ low: 570, high: 675 }),
    WASTE_PCT: 0.15,
    FORM_ENDPOINT: "https://formspree.io/f/mgegprnp",
    MAP_CENTER: Object.freeze({ lat: 40.589, lng: -83.128 }),
    AUTO_FIND_RADIUS_METERS: 55,
    MAX_BUILDING_DISTANCE_METERS: 45
});

let map;
let autocomplete;
let selectedPlace = null;
let placeMarker = null;
let currentPolygon = null;
let polygonListeners = [];
let drawListener = null;
let drawingPoints = [];
let drawingLine = null;
let isDrawing = false;
let isSubmitting = false;
let lastSubmissionKey = "";

const byId = (id) => document.getElementById(id);

function initEstimator() {
    map = new google.maps.Map(byId("map"), {
        center: CONFIG.MAP_CENTER,
        zoom: 14,
        mapTypeId: "hybrid",
        tilt: 0,
        streetViewControl: false,
        fullscreenControl: true,
        mapTypeControl: true
    });

    autocomplete = new google.maps.places.Autocomplete(byId("address"), {
        fields: ["geometry", "formatted_address", "place_id", "name"],
        componentRestrictions: { country: "us" },
        types: ["address"]
    });

    autocomplete.addListener("place_changed", handlePlaceSelected);
    byId("address").addEventListener("input", handleAddressEdited);
    byId("slopeRange").addEventListener("input", handleSlopeChanged);
    byId("autoFootprintBtn").addEventListener("click", () => tryAutoFootprint(true));
    byId("drawRoofBtn").addEventListener("click", toggleDrawing);
    byId("clearBtn").addEventListener("click", clearOutline);
    byId("estimateBtn").addEventListener("click", calculateAndSubmit);
    byId("phone").addEventListener("input", formatPhoneNumber);

    ["fullName", "email", "phone"].forEach((id) => {
        byId(id).addEventListener("input", () => {
            byId(id).classList.remove("is-invalid");
            lastSubmissionKey = "";
        });
    });
}

window.addEventListener("load", () => {
    if (!window.google?.maps?.geometry || !window.google?.maps?.places) {
        showStatus("The map could not load. Please refresh the page or call Crockett Construction for an estimate.", "error");
        return;
    }
    initEstimator();
});

function handlePlaceSelected() {
    const place = autocomplete.getPlace();
    if (!place.geometry?.location) {
        selectedPlace = null;
        showStatus("Choose a complete address from the suggestion list.", "error");
        return;
    }

    selectedPlace = place;
    byId("address").value = place.formatted_address || place.name || byId("address").value;
    byId("address").classList.remove("is-invalid");
    lastSubmissionKey = "";

    if (place.geometry.viewport) {
        map.fitBounds(place.geometry.viewport);
    } else {
        map.setCenter(place.geometry.location);
    }
    map.setZoom(20);

    if (placeMarker) placeMarker.setMap(null);
    placeMarker = new google.maps.Marker({
        map,
        position: place.geometry.location,
        title: place.formatted_address || place.name || "Selected property"
    });

    setPolygon(null);
    hideStatus();
    tryAutoFootprint(false);
}

function handleAddressEdited() {
    selectedPlace = null;
    lastSubmissionKey = "";
    byId("address").classList.remove("is-invalid");
}

function handleSlopeChanged() {
    byId("slopeValue").textContent = `${byId("slopeRange").value}/12`;
    lastSubmissionKey = "";
    updateCalculations();
}

function toggleDrawing() {
    if (isDrawing) {
        finishDrawing();
    } else {
        startDrawing();
    }
}

function startDrawing() {
    if (!selectedPlace) {
        showStatus("Choose the property address from the suggestion list before drawing the roof.", "error");
        markInvalid(byId("address"));
        return;
    }

    setPolygon(null);
    drawingPoints = [];
    isDrawing = true;
    map.setOptions({ draggableCursor: "crosshair" });
    byId("drawRoofBtn").textContent = "Finish Outline";
    byId("drawRoofBtn").classList.remove("secondary");
    showStatus("Click each outside corner of the roof. After at least three points, click Finish Outline.", "info");

    drawingLine = new google.maps.Polyline({
        map,
        path: drawingPoints,
        strokeColor: "#f36f21",
        strokeOpacity: 1,
        strokeWeight: 3
    });

    drawListener = map.addListener("click", (event) => {
        drawingPoints.push(event.latLng);
        drawingLine.setPath(drawingPoints);
        if (drawingPoints.length >= 3) {
            showStatus(`${drawingPoints.length} corners added. Continue adding corners or click Finish Outline.`, "info");
        }
    });
}

function finishDrawing() {
    if (drawingPoints.length < 3) {
        showStatus("Add at least three roof corners before finishing the outline.", "error");
        return;
    }

    const polygon = createRoofPolygon(drawingPoints);
    stopDrawing();
    setPolygon(polygon);
    showStatus("Roof outline added. Drag any corner to correct it before calculating.", "success");
}

function stopDrawing() {
    if (drawListener) google.maps.event.removeListener(drawListener);
    drawListener = null;
    if (drawingLine) drawingLine.setMap(null);
    drawingLine = null;
    drawingPoints = [];
    isDrawing = false;
    map?.setOptions({ draggableCursor: null });
    byId("drawRoofBtn").textContent = "Draw Roof";
    byId("drawRoofBtn").classList.add("secondary");
}

function clearOutline() {
    stopDrawing();
    setPolygon(null);
    hideStatus();
}

function createRoofPolygon(path) {
    return new google.maps.Polygon({
        paths: path,
        map,
        fillColor: "#f36f21",
        fillOpacity: 0.25,
        strokeColor: "#f36f21",
        strokeOpacity: 1,
        strokeWeight: 3,
        clickable: false,
        editable: true
    });
}

function setPolygon(polygon) {
    polygonListeners.forEach((listener) => google.maps.event.removeListener(listener));
    polygonListeners = [];
    if (currentPolygon && currentPolygon !== polygon) currentPolygon.setMap(null);
    currentPolygon = polygon;
    lastSubmissionKey = "";

    if (currentPolygon) {
        currentPolygon.setMap(map);
        const path = currentPolygon.getPath();
        ["insert_at", "remove_at", "set_at"].forEach((eventName) => {
            polygonListeners.push(path.addListener(eventName, () => {
                lastSubmissionKey = "";
                updateCalculations();
            }));
        });
    }
    updateCalculations();
}

async function tryAutoFootprint(showFailureMessage) {
    if (!selectedPlace?.geometry?.location) {
        showStatus("Choose the property address from the suggestion list first.", "error");
        markInvalid(byId("address"));
        return;
    }

    stopDrawing();
    const button = byId("autoFootprintBtn");
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Searching...";

    const location = selectedPlace.geometry.location;
    const lat = location.lat();
    const lng = location.lng();
    const query = `[out:json][timeout:20];way(around:${CONFIG.AUTO_FIND_RADIUS_METERS},${lat},${lng})["building"];out body;>;out skel qt;`;
    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);

    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Outline service returned ${response.status}`);
        const data = await response.json();
        const path = chooseClosestBuilding(data, location);

        if (!path) {
            if (showFailureMessage) showStatus("An accurate building outline was not found. Use Draw Roof to trace it manually.", "info");
            return;
        }

        const polygon = createRoofPolygon(path);
        setPolygon(polygon);
        zoomToPolygon(polygon);
        showStatus("A nearby building outline was found. Verify it is your roof and drag the corners if needed.", "success");
    } catch (error) {
        console.warn("Automatic outline search failed:", error);
        if (showFailureMessage) showStatus("Automatic detection is unavailable right now. Use Draw Roof to trace the roof manually.", "info");
    } finally {
        window.clearTimeout(timeout);
        button.disabled = false;
        button.textContent = originalText;
    }
}

function chooseClosestBuilding(data, targetLocation) {
    const nodes = new Map();
    const paths = [];

    for (const element of data.elements || []) {
        if (element.type === "node") nodes.set(element.id, { lat: element.lat, lng: element.lon });
    }

    for (const element of data.elements || []) {
        if (element.type !== "way" || !Array.isArray(element.nodes) || element.nodes.length < 4) continue;
        const nodeIds = element.nodes[0] === element.nodes[element.nodes.length - 1]
            ? element.nodes.slice(0, -1)
            : element.nodes;
        const path = nodeIds.map((nodeId) => nodes.get(nodeId)).filter(Boolean);
        if (path.length >= 3) paths.push(path);
    }

    let bestPath = null;
    let bestDistance = Infinity;

    for (const path of paths) {
        const testPolygon = new google.maps.Polygon({ paths: path });
        if (google.maps.geometry.poly.containsLocation(targetLocation, testPolygon)) return path;

        const center = polygonCenter(path);
        const distance = google.maps.geometry.spherical.computeDistanceBetween(targetLocation, center);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestPath = path;
        }
    }

    return bestDistance <= CONFIG.MAX_BUILDING_DISTANCE_METERS ? bestPath : null;
}

function polygonCenter(path) {
    const bounds = new google.maps.LatLngBounds();
    path.forEach((point) => bounds.extend(point));
    return bounds.getCenter();
}

function zoomToPolygon(polygon) {
    const bounds = new google.maps.LatLngBounds();
    polygon.getPath().forEach((point) => bounds.extend(point));
    map.fitBounds(bounds, 45);
}

function getPolygonAreaSqft(polygon) {
    if (!polygon || polygon.getPath().getLength() < 3) return 0;
    const squareMeters = google.maps.geometry.spherical.computeArea(polygon.getPath());
    return squareMeters * 10.7639;
}

function getSlopeFactor(risePer12) {
    const rise = Number(risePer12) || 0;
    return Math.sqrt(1 + Math.pow(rise / 12, 2));
}

function getMeasurements() {
    const footprintSqft = getPolygonAreaSqft(currentPolygon);
    const slope = Number(byId("slopeRange").value);
    const slopeFactor = getSlopeFactor(slope);
    const orderSqft = footprintSqft * slopeFactor * (1 + CONFIG.WASTE_PCT);
    return {
        footprintSqft,
        slope,
        slopeFactor,
        orderSqft,
        roofingSquares: orderSqft / 100
    };
}

function updateCalculations() {
    const measurements = getMeasurements();
    const results = byId("calcResults");

    if (measurements.footprintSqft <= 0) {
        results.hidden = true;
        return;
    }

    byId("footprintSqft").textContent = Math.round(measurements.footprintSqft).toLocaleString();
    byId("slopeFactor").textContent = measurements.slopeFactor.toFixed(3);
    byId("wastePct").textContent = `${Math.round(CONFIG.WASTE_PCT * 100)}%`;
    byId("surfaceSqft").textContent = Math.round(measurements.orderSqft).toLocaleString();
    byId("roofingSquares").textContent = measurements.roofingSquares.toFixed(1);
    results.hidden = false;
}

function computeEstimate() {
    const measurements = getMeasurements();
    if (measurements.footprintSqft <= 0) return null;

    // Round upward to the next $100 so the displayed low end never falls below $570/square.
    const priceLow = Math.ceil((measurements.roofingSquares * CONFIG.PRICE_PER_SQUARE.low) / 100) * 100;
    const priceHigh = Math.ceil((measurements.roofingSquares * CONFIG.PRICE_PER_SQUARE.high) / 100) * 100;

    return {
        address: selectedPlace?.formatted_address || byId("address").value.trim(),
        roofType: "Architectural shingles",
        slope: `${measurements.slope}/12`,
        slopeFactor: measurements.slopeFactor,
        footprintSqft: measurements.footprintSqft,
        orderSqft: measurements.orderSqft,
        roofingSquares: measurements.roofingSquares,
        wastePct: CONFIG.WASTE_PCT,
        pricePerSquareLow: CONFIG.PRICE_PER_SQUARE.low,
        pricePerSquareHigh: CONFIG.PRICE_PER_SQUARE.high,
        priceLow,
        priceHigh
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
        showStatus("Find or draw the roof outline before calculating the price.", "error");
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
    const button = byId("estimateBtn");
    button.disabled = true;
    button.textContent = "Sending...";

    try {
        await sendToFormspree(payload);
        lastSubmissionKey = submissionKey;
        showStatus("Your estimate is ready and your information was sent to Crockett Construction.", "success");
    } catch (error) {
        console.error("Estimate submission failed:", error);
        showStatus("Your price is displayed, but your information could not be sent. Please call Crockett Construction to follow up.", "error");
    } finally {
        isSubmitting = false;
        button.disabled = false;
        button.textContent = "Recalculate My Price";
    }
}

function validateRequiredInformation() {
    if (!selectedPlace?.geometry?.location) {
        markInvalid(byId("address"));
        return { ok: false, message: "Choose the complete property address from the suggestion list.", element: byId("address") };
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

function markInvalid(element) {
    element.classList.add("is-invalid");
    element.setAttribute("aria-invalid", "true");
}

function renderEstimate(estimate) {
    const money = (amount) => amount.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0
    });

    byId("estimateBox").innerHTML = `
        <div class="estimator-price-row">
            <div class="estimator-price-card">
                <h3>Estimated Low</h3>
                <div class="estimator-price">${money(estimate.priceLow)}</div>
                <span class="estimator-price-note">Starting at $${estimate.pricePerSquareLow} per roofing square</span>
            </div>
            <div class="estimator-price-card">
                <h3>Estimated High</h3>
                <div class="estimator-price">${money(estimate.priceHigh)}</div>
                <span class="estimator-price-note">Up to $${estimate.pricePerSquareHigh} per roofing square</span>
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
        googlePlaceId: selectedPlace?.place_id || ""
    };
}

async function sendToFormspree(payload) {
    const formData = new FormData();
    Object.entries(payload).forEach(([key, value]) => formData.append(key, String(value)));
    formData.append("_subject", `New Roof Estimate - ${payload.address}`);

    const response = await fetch(CONFIG.FORM_ENDPOINT, {
        method: "POST",
        body: formData,
        headers: { Accept: "application/json" }
    });

    if (!response.ok) {
        const details = await response.json().catch(() => ({}));
        throw new Error(details.error || `Form service returned ${response.status}`);
    }
}

function formatPhoneNumber(event) {
    const digits = event.target.value.replace(/\D/g, "").slice(0, 10);
    if (digits.length <= 3) event.target.value = digits;
    else if (digits.length <= 6) event.target.value = `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    else event.target.value = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
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
