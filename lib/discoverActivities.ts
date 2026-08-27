// Stand-in for the real data pipeline (Ticketmaster/SeatGeek + an
// AI-assisted crawl for community events, both feeding one cached table -
// see the Open Slots roadmap) - lets the Discover screen and the
// long-press-to-discover gesture in WeekGrid get built and feel right
// before any of that backend exists.

export type ActivityCategory =
  | 'movies'
  | 'music'
  | 'dance'
  | 'carnival'
  | 'farmers_market'
  | 'family'
  | 'sports'
  | 'community';

export const CATEGORY_LABELS: Record<ActivityCategory, string> = {
  movies: 'Movies',
  music: 'Music',
  dance: 'Dances',
  carnival: 'Carnivals',
  farmers_market: 'Farmers Markets',
  family: 'Family',
  sports: 'Sports',
  community: 'Community',
};

export type Activity = {
  id: string;
  title: string;
  category: ActivityCategory;
  date: string; // yyyy-mm-dd
  startTime: string; // HH:mm, 24h
  endTime: string | null;
  location: string;
  distanceMiles: number;
  price: string; // "Free", "$12", "$8+", etc.
  source: string;
  url: string;
  description: string;
};

const pad = (n: number) => String(n).padStart(2, '0');

// Every mock date is relative to today, so whatever day gets long-pressed
// in WeekGrid actually has something to show instead of going stale the
// moment this ships.
const dateOffset = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const MOCK_ACTIVITIES: Activity[] = [
  {
    id: 'a1',
    title: 'Downtown Farmers Market',
    category: 'farmers_market',
    date: dateOffset(0),
    startTime: '08:00',
    endTime: '12:00',
    location: 'Main Street Plaza',
    distanceMiles: 2.1,
    price: 'Free',
    source: 'Community',
    url: 'https://example.com/farmers-market',
    description: 'Local produce, honey, and live music every week.',
  },
  {
    id: 'a2',
    title: 'Matinee: The Wild Robot',
    category: 'movies',
    date: dateOffset(0),
    startTime: '13:30',
    endTime: '15:15',
    location: 'Cinemark 12',
    distanceMiles: 4.8,
    price: '$9',
    source: 'Fandango',
    url: 'https://example.com/movies/wild-robot',
    description: 'Matinee pricing before 4pm.',
  },
  {
    id: 'a3',
    title: 'Sunset Line Dancing',
    category: 'dance',
    date: dateOffset(0),
    startTime: '18:00',
    endTime: '20:00',
    location: 'Riverside Park Pavilion',
    distanceMiles: 3.4,
    price: 'Free',
    source: 'Community',
    url: 'https://example.com/line-dancing',
    description: 'All skill levels welcome, no partner needed.',
  },
  {
    id: 'a4',
    title: 'County Fair & Carnival',
    category: 'carnival',
    date: dateOffset(1),
    startTime: '11:00',
    endTime: '22:00',
    location: 'Fairgrounds',
    distanceMiles: 9.6,
    price: '$15',
    source: 'Ticketmaster',
    url: 'https://example.com/county-fair',
    description: 'Rides, games, and a livestock show.',
  },
  {
    id: 'a5',
    title: 'Youth Soccer Tournament',
    category: 'sports',
    date: dateOffset(1),
    startTime: '09:00',
    endTime: '13:00',
    location: 'Community Sports Complex',
    distanceMiles: 6.2,
    price: 'Free',
    source: 'SeatGeek',
    url: 'https://example.com/soccer-tournament',
    description: 'Bracket play all morning, concessions on site.',
  },
  {
    id: 'a6',
    title: 'Jazz on the Patio',
    category: 'music',
    date: dateOffset(1),
    startTime: '19:00',
    endTime: '21:30',
    location: 'The Copper Kettle',
    distanceMiles: 5.0,
    price: '$10',
    source: 'SeatGeek',
    url: 'https://example.com/jazz-patio',
    description: 'Local trio, outdoor seating, 21+ after 8pm.',
  },
  {
    id: 'a7',
    title: 'Toddler Story Time',
    category: 'family',
    date: dateOffset(2),
    startTime: '10:00',
    endTime: '10:45',
    location: 'Public Library - Main Branch',
    distanceMiles: 1.5,
    price: 'Free',
    source: 'Community',
    url: 'https://example.com/story-time',
    description: 'Ages 0-5, songs and a craft after.',
  },
  {
    id: 'a8',
    title: 'Neighborhood Cleanup Day',
    category: 'community',
    date: dateOffset(2),
    startTime: '09:00',
    endTime: '12:00',
    location: 'Creekside Park',
    distanceMiles: 2.8,
    price: 'Free',
    source: 'Community',
    url: 'https://example.com/cleanup-day',
    description: 'Gloves and bags provided, sign in at the pavilion.',
  },
  {
    id: 'a9',
    title: 'Evening Matinee: Superstar',
    category: 'movies',
    date: dateOffset(2),
    startTime: '19:45',
    endTime: '21:50',
    location: 'Cinemark 12',
    distanceMiles: 4.8,
    price: '$13',
    source: 'Fandango',
    url: 'https://example.com/movies/superstar',
    description: '',
  },
  {
    id: 'a10',
    title: 'Salsa Night',
    category: 'dance',
    date: dateOffset(3),
    startTime: '20:00',
    endTime: '23:00',
    location: 'The Grand Ballroom',
    distanceMiles: 7.3,
    price: '$12',
    source: 'Ticketmaster',
    url: 'https://example.com/salsa-night',
    description: 'Beginner lesson at 8, open dancing after 9.',
  },
  {
    id: 'a11',
    title: 'Farmers Market - Midweek Pop-Up',
    category: 'farmers_market',
    date: dateOffset(3),
    startTime: '15:00',
    endTime: '18:00',
    location: 'Westside Commons',
    distanceMiles: 3.9,
    price: 'Free',
    source: 'Community',
    url: 'https://example.com/farmers-market-westside',
    description: 'Smaller midweek market, food trucks included.',
  },
  {
    id: 'a12',
    title: 'High School Football: Home Game',
    category: 'sports',
    date: dateOffset(3),
    startTime: '19:00',
    endTime: '21:30',
    location: 'Memorial Stadium',
    distanceMiles: 5.5,
    price: '$8',
    source: 'SeatGeek',
    url: 'https://example.com/football-home-game',
    description: '',
  },
  {
    id: 'a13',
    title: 'Craft Beer & Carnival Rides',
    category: 'carnival',
    date: dateOffset(4),
    startTime: '17:00',
    endTime: '23:00',
    location: 'Fairgrounds',
    distanceMiles: 9.6,
    price: '$10',
    source: 'Ticketmaster',
    url: 'https://example.com/beer-carnival',
    description: '21+ beer garden, rides open to all ages.',
  },
  {
    id: 'a14',
    title: 'Acoustic Open Mic',
    category: 'music',
    date: dateOffset(4),
    startTime: '18:30',
    endTime: '21:00',
    location: 'Roasted Bean Coffeehouse',
    distanceMiles: 2.3,
    price: 'Free',
    source: 'Community',
    url: 'https://example.com/open-mic',
    description: 'Sign-up starts at 6.',
  },
  {
    id: 'a15',
    title: 'Family Fun Run (1 Mile & 5K)',
    category: 'family',
    date: dateOffset(5),
    startTime: '08:00',
    endTime: '10:00',
    location: 'Riverside Park',
    distanceMiles: 3.4,
    price: '$20',
    source: 'Ticketmaster',
    url: 'https://example.com/fun-run',
    description: 'Strollers and dogs on a leash welcome.',
  },
  {
    id: 'a16',
    title: 'Weekend Matinee: Family Double Feature',
    category: 'movies',
    date: dateOffset(5),
    startTime: '11:00',
    endTime: '14:30',
    location: 'Cinemark 12',
    distanceMiles: 4.8,
    price: '$11',
    source: 'Fandango',
    url: 'https://example.com/movies/double-feature',
    description: '',
  },
  {
    id: 'a17',
    title: 'Ballroom Social',
    category: 'dance',
    date: dateOffset(6),
    startTime: '19:30',
    endTime: '22:00',
    location: 'The Grand Ballroom',
    distanceMiles: 7.3,
    price: '$8',
    source: 'Community',
    url: 'https://example.com/ballroom-social',
    description: 'Waltz, foxtrot, and swing - all levels.',
  },
  {
    id: 'a18',
    title: 'Farmers Market',
    category: 'farmers_market',
    date: dateOffset(7),
    startTime: '08:00',
    endTime: '12:00',
    location: 'Main Street Plaza',
    distanceMiles: 2.1,
    price: 'Free',
    source: 'Community',
    url: 'https://example.com/farmers-market',
    description: 'Local produce, honey, and live music every week.',
  },
];

export const toMinutes = (time: string): number => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

export const parseDateAndTime = (date: string, time: string): Date => {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const result = new Date();
  result.setFullYear(y, m - 1, d);
  result.setHours(hh, mm, 0, 0);
  return result;
};
