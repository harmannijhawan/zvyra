/**
 * OWNER: Kiro. Real weather (E.D.I.T.H. only opened a Google search) using
 * Open-Meteo — free, no API key. Geocodes the city, then fetches current
 * conditions and a short daily forecast.
 */

const CODES: Record<number, string> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers',
  85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail'
}

interface Geo {
  name: string
  country?: string
  admin1?: string
  latitude: number
  longitude: number
}

export async function weather(city: string, days = 3) {
  const q = city.trim()
  if (!q) throw new Error('Which city?')
  const g = (await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`, { signal: AbortSignal.timeout(10_000) })).json()) as { results?: Geo[] }
  const place = g.results?.[0]
  if (!place) throw new Error(`I couldn’t find a place called “${q}”.`)
  const n = Math.max(1, Math.min(7, Math.round(days)))
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day' +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=${n}`
  const w = (await (await fetch(url, { signal: AbortSignal.timeout(10_000) })).json()) as {
    current?: { temperature_2m: number; apparent_temperature: number; relative_humidity_2m: number; weather_code: number; wind_speed_10m: number }
    daily?: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: (number | null)[] }
  }
  const c = w.current
  if (!c) throw new Error('The weather service didn’t answer')
  const where = [place.name, place.admin1, place.country].filter(Boolean).join(', ')
  const forecast = (w.daily?.time ?? []).map((d, i) => ({
    day: new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'long' }),
    conditions: CODES[w.daily!.weather_code[i]] ?? 'mixed',
    highC: Math.round(w.daily!.temperature_2m_max[i]),
    lowC: Math.round(w.daily!.temperature_2m_min[i]),
    rainChance: w.daily!.precipitation_probability_max[i] ?? undefined
  }))
  return {
    place: where,
    now: {
      conditions: CODES[c.weather_code] ?? 'mixed',
      temperatureC: Math.round(c.temperature_2m),
      feelsLikeC: Math.round(c.apparent_temperature),
      humidity: c.relative_humidity_2m,
      windKmh: Math.round(c.wind_speed_10m)
    },
    forecast,
    summary: `${where}: ${CODES[c.weather_code] ?? 'mixed'}, ${Math.round(c.temperature_2m)}°C (feels ${Math.round(c.apparent_temperature)}°C), wind ${Math.round(c.wind_speed_10m)} km/h.`
  }
}
