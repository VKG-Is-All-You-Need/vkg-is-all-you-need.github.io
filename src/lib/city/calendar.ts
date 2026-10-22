/** 时间轴上的标记：某一天的高峰、天气时段与社区活动（时间为当天的秒数）。 */
import { events } from './people';
import { DAY, DAYS, dayOf, hours } from './time';
import { weatherEpisodes } from './weather';

export type MarkerKind = 'rush' | 'rain' | 'fog' | 'storm' | 'event';

export interface Marker {
  label: string;
  from: number;
  to: number;
  kind: MarkerKind;
}

const WEATHER_LABEL = { rain: '降雨', storm: '雷阵雨', drizzle: '小雨', fog: '大雾' } as const;

export function dayMarkers(day: number): Marker[] {
  const markers: Marker[] = [];
  if (!DAYS[day].weekend) {
    markers.push(
      { label: '早高峰', from: hours(7, 45), to: hours(9, 15), kind: 'rush' },
      { label: '晚高峰', from: hours(17, 30), to: hours(19), kind: 'rush' },
    );
  }
  for (const episode of weatherEpisodes(day)) {
    markers.push({
      label: WEATHER_LABEL[episode.kind],
      from: episode.start - day * DAY,
      to: episode.end - day * DAY,
      kind: episode.kind === 'fog' ? 'fog' : episode.kind === 'storm' ? 'storm' : 'rain',
    });
  }
  for (const event of events.filter((e) => dayOf(e.start) === day)) {
    markers.push({
      label: event.title,
      from: event.start - day * DAY,
      to: event.end - day * DAY,
      kind: 'event',
    });
  }
  return markers;
}
