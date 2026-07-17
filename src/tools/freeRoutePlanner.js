const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const OSRM_ENDPOINT = 'https://router.project-osrm.org';
const MAX_OPTIMIZED_STOPS = 8;
const DEFAULT_USER_AGENT = 'JarvisDiscordBot/1.0 (route-planner)';

function normalizeAddress(address) {
  return String(address ?? '').replace(/\s+/g, ' ').trim();
}

function buildAddressQuery(stop, defaultArea = '') {
  const parts = [stop.address, stop.area, defaultArea, 'Italia']
    .map(normalizeAddress)
    .filter(Boolean);
  return [...new Set(parts)].join(', ');
}

function formatCoordinate(stop) {
  return `${stop.lon},${stop.lat}`;
}

function formatKm(meters) {
  return `${(meters / 1000).toFixed(1).replace('.', ',')} km`;
}

function formatMinutes(seconds) {
  return `${Math.round(seconds / 60)} min`;
}

function permutations(items) {
  if (items.length <= 1) return [items];

  const result = [];
  for (let index = 0; index < items.length; index += 1) {
    const current = items[index];
    const remaining = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const rest of permutations(remaining)) {
      result.push([current, ...rest]);
    }
  }
  return result;
}

function getPathCost(order, matrix) {
  let cost = 0;
  for (let index = 0; index < order.length - 1; index += 1) {
    const segmentCost = matrix[order[index]]?.[order[index + 1]];
    if (!Number.isFinite(segmentCost)) return Number.POSITIVE_INFINITY;
    cost += segmentCost;
  }
  return cost;
}

function findBestOpenOrder(matrix, fixedStartIndex = null) {
  const indexes = matrix.map((_, index) => index);

  if (indexes.length > MAX_OPTIMIZED_STOPS) {
    return Number.isInteger(fixedStartIndex)
      ? [fixedStartIndex, ...indexes.filter((index) => index !== fixedStartIndex)]
      : indexes;
  }

  const candidateOrders = Number.isInteger(fixedStartIndex)
    ? permutations(indexes.filter((index) => index !== fixedStartIndex)).map((order) => [fixedStartIndex, ...order])
    : permutations(indexes);

  let bestOrder = indexes;
  let bestCost = Number.POSITIVE_INFINITY;

  for (const order of candidateOrders) {
    const cost = getPathCost(order, matrix);
    if (cost < bestCost) {
      bestCost = cost;
      bestOrder = order;
    }
  }

  return bestOrder;
}

function buildGoogleMapsDirectionsUrl(stops) {
  if (stops.length === 0) return null;
  if (stops.length === 1) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stops[0].query)}`;
  }

  const origin = encodeURIComponent(stops[0].query);
  const destination = encodeURIComponent(stops.at(-1).query);
  const waypoints = stops.slice(1, -1).map((stop) => stop.query).join('|');
  const waypointParam = waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : '';

  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}${waypointParam}&travelmode=driving`;
}

function buildOpenStreetMapUrl(stops) {
  const coordinates = stops.map((stop) => `${stop.lat},${stop.lon}`).join(';');
  return `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${encodeURIComponent(coordinates)}`;
}

async function geocodeStop(stop, options = {}) {
  const query = buildAddressQuery(stop, options.defaultArea);
  const url = new URL(NOMINATIM_ENDPOINT);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('q', query);

  const response = await fetch(url, {
    headers: {
      'User-Agent': process.env.NOMINATIM_USER_AGENT || DEFAULT_USER_AGENT,
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Nominatim error ${response.status}`);
  }

  const results = await response.json();
  const match = results[0];
  if (!match) {
    return { ...stop, query, geocoded: false };
  }

  return {
    ...stop,
    query,
    geocoded: true,
    lat: Number.parseFloat(match.lat),
    lon: Number.parseFloat(match.lon),
    displayName: match.display_name
  };
}

async function getDurationMatrix(stops) {
  const coordinates = stops.map(formatCoordinate).join(';');
  const url = `${OSRM_ENDPOINT}/table/v1/driving/${coordinates}?annotations=duration,distance`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });

  if (!response.ok) {
    throw new Error(`OSRM table error ${response.status}`);
  }

  const data = await response.json();
  if (data.code !== 'Ok' || !Array.isArray(data.durations)) {
    throw new Error(`OSRM table returned ${data.code ?? 'invalid response'}`);
  }

  return data;
}

async function getRouteSummary(stops) {
  const coordinates = stops.map(formatCoordinate).join(';');
  const url = `${OSRM_ENDPOINT}/route/v1/driving/${coordinates}?overview=false&steps=false`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });

  if (!response.ok) {
    throw new Error(`OSRM route error ${response.status}`);
  }

  const data = await response.json();
  const route = data.routes?.[0];
  if (data.code !== 'Ok' || !route) {
    throw new Error(`OSRM route returned ${data.code ?? 'invalid response'}`);
  }

  return route;
}

export async function planFreeOptimizedRoute(rawStops, options = {}) {
  const normalizedStops = rawStops
    .map((stop, index) => ({
      label: String(stop.label ?? index + 1),
      area: normalizeAddress(stop.area),
      address: normalizeAddress(stop.address ?? stop.text ?? stop),
      isStart: Boolean(stop.isStart ?? stop.start ?? stop.is_start)
    }))
    .filter((stop) => stop.address);

  if (normalizedStops.length < 2) {
    return { ok: false, reason: 'not_enough_stops', stops: normalizedStops };
  }

  const geocodedStops = [];
  for (const stop of normalizedStops) {
    geocodedStops.push(await geocodeStop(stop, options));
  }

  const missingStops = geocodedStops.filter((stop) => !stop.geocoded || !Number.isFinite(stop.lat) || !Number.isFinite(stop.lon));
  if (missingStops.length > 0) {
    return { ok: false, reason: 'geocoding_failed', stops: geocodedStops, missingStops };
  }

  const matrix = await getDurationMatrix(geocodedStops);
  const fixedStartIndex = geocodedStops.findIndex((stop) => stop.isStart);
  const bestOrder = findBestOpenOrder(matrix.durations, fixedStartIndex >= 0 ? fixedStartIndex : null);
  const orderedStops = bestOrder.map((index) => geocodedStops[index]);
  const route = await getRouteSummary(orderedStops);

  return {
    ok: true,
    stops: geocodedStops,
    orderedStops,
    distanceMeters: route.distance,
    durationSeconds: route.duration,
    distanceText: formatKm(route.distance),
    durationText: formatMinutes(route.duration),
    googleMapsUrl: buildGoogleMapsDirectionsUrl(orderedStops),
    openStreetMapUrl: buildOpenStreetMapUrl(orderedStops),
    optimized: geocodedStops.length <= MAX_OPTIMIZED_STOPS
  };
}

export function formatRoutePlanForDiscord(plan) {
  if (!plan.ok) {
    if (plan.reason === 'not_enough_stops') {
      return 'Ho bisogno di almeno due indirizzi per calcolare un percorso.';
    }

    if (plan.reason === 'geocoding_failed') {
      const missing = plan.missingStops
        .map((stop) => `- ${stop.address}${stop.area ? `, ${stop.area}` : ''}`)
        .join('\n');
      return `Non sono riuscito a trovare questi indirizzi con la ricerca gratuita OpenStreetMap:\n${missing}\n\nScrivimeli con città/provincia e riprovo.`;
    }

    return 'Non sono riuscito a calcolare il percorso gratuito in questo momento.';
  }

  const lines = [
    `Percorso migliore in auto calcolato con strumenti gratuiti: ${plan.distanceText}, circa ${plan.durationText}.`,
    plan.optimized ? 'Ho ottimizzato l’ordine delle tappe per ridurre il tempo totale.' : 'Ho mantenuto l’ordine ricevuto perché ci sono troppe tappe per ottimizzare gratis in modo sicuro.',
    '',
    'Ordine consigliato:'
  ];

  plan.orderedStops.forEach((stop, index) => {
    lines.push(`${index + 1}. ${stop.address}${stop.area ? `, ${stop.area}` : ''}`);
  });

  lines.push('', `Apri percorso in Google Maps: ${plan.googleMapsUrl}`);
  lines.push(`Apri percorso in OpenStreetMap: ${plan.openStreetMapUrl}`);

  return lines.join('\n');
}
