// Buses, and where you board them.
//
// The point of this file is one number: `boardIdx`, how far into a route your
// stop is. Board at stop 3 of 37 and you sit down; board at stop 30 and you
// stand for an hour. Nobody tells you which, and it is the difference between
// a journey you can do every day and one you dread. It costs nothing to know -
// it is in the timetable already.
//
// BMTC routes below are real: extracted from BMTC's published GTFS
// (github.com/Vonter/bmtc-gtfs, ODbL) - the stops, the run times, the median
// gap between buses, the first and last departure, and the boarding position.
//
// The KSRTC route is NOT. Bangarpet to Bengaluru is a real service that runs
// every day; Karnataka has simply never published its timetable as open data
// (the World Bank said as much in its assessment of the state). So it is
// modelled here and marked `simulated`, and every screen that shows it says so.
// Inventing the numbers would be dishonest; leaving out the leg that makes the
// whole journey work would be worse.

export const BUSES = [{"id":"KBS-1K","op":"BMTC","from":"Hope Farm","to":"Kempegowda Bus Station","fromLat":12.98273,"fromLng":77.75223,"toLat":12.97749,"toLng":77.57327,"runMin":93,"every":14,"first":245,"last":1350,"boardIdx":2,"nStops":37,"trips":71,"source":"timetable"},{"id":"KBS-1I","op":"BMTC","from":"Hope Farm","to":"Kempegowda Bus Station","fromLat":12.98382,"fromLng":77.75189,"toLat":12.97749,"toLng":77.57327,"runMin":94,"every":13,"first":264,"last":1285,"boardIdx":2,"nStops":44,"trips":63,"source":"timetable"},{"id":"V-335E","op":"BMTC","from":"Hope Farm","to":"Kempegowda Bus Station","fromLat":12.98382,"fromLng":77.75189,"toLat":12.97749,"toLng":77.57327,"runMin":84,"every":10,"first":345,"last":1340,"boardIdx":2,"nStops":43,"trips":60,"source":"timetable"},{"id":"KSRTC BNG-BLR","op":"KSRTC","from":"Bangarpet Bus Stand","to":"Whitefield / Hope Farm","fromLat":12.9925,"fromLng":78.176,"toLat":12.98273,"toLng":77.75223,"runMin":95,"every":30,"first":300,"last":1260,"boardIdx":0,"nStops":18,"trips":32,"source":"simulated"}];

/** Where a bus stops, for the map: a straight line between its two ends is a
    lie, but a line along the road it takes needs a shape the feed does not
    carry for these routes. So the map draws the two ends and says it is a bus. */
export const BUS_FARE_PER_KM = 1.2;
export const BUS_MIN_FARE = 6;

/**
 * What the ride actually costs, in rupees.
 *
 * This used to be 1.2 rupees a straight-line kilometre with a six-rupee floor,
 * and it was wrong twice over. A bus does not fly: the road between two stops
 * is about a third longer than the line between them, so the distance was
 * understated before the rate was even applied. And BMTC does not charge by
 * the kilometre at all - it charges by stage, and the stages climb far faster
 * than 1.2 a kilometre. Hebbal to Majestic came out at ten rupees. Nobody has
 * ridden that bus for ten rupees in a long time.
 *
 * The numbers below are the published stage fares rounded to what a passenger
 * actually hands over, not a formula pretending to be one. They remain an
 * estimate - khaali does not have BMTC's fare table - and the About page says
 * so along with everything else khaali invents.
 */
export const ROAD_FACTOR = 1.35;          // straight line -> road, Bengaluru

/** BMTC ordinary, by stage. Each entry is [up to N road km, rupees]. */
export const BUS_STAGES = [
  [2, 6], [4, 11], [6, 16], [9, 21], [12, 26], [16, 31], [22, 36], [25, 41],
];

/** Beyond the city stages it is an intercity coach, and priced like one. */
export const COACH_PER_KM = 1.6;

export function busFareFor(straightKm) {
  const road = Math.max(0, straightKm) * ROAD_FACTOR;
  for (const [upTo, rupees] of BUS_STAGES) if (road <= upTo) return rupees;
  return Math.max(41, Math.round(road * COACH_PER_KM / 5) * 5);
}
