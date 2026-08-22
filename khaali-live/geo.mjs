// Approximate real-world coordinates for the corridor's stations, in the same
// order as ST in data.mjs (Bangarpet -> Bengaluru -> Mysuru Jn). Good enough to
// draw the line and animate trains; not survey-grade.
export const GEO = [
  { c: 'BWT',  lat: 12.9908, lng: 78.1770 },   // Bangarpet
  { c: 'WFD',  lat: 12.9846, lng: 77.7460 },   // Whitefield
  { c: 'KJM',  lat: 13.0004, lng: 77.6766 },   // K R Puram
  { c: 'BNCE', lat: 12.9973, lng: 77.6202 },   // Bengaluru East
  { c: 'BNC',  lat: 12.9932, lng: 77.5958 },   // Bengaluru Cantt
  { c: 'SBC',  lat: 12.9779, lng: 77.5697 },   // Bengaluru (KSR City)
  { c: 'KGI',  lat: 12.9066, lng: 77.4820 },   // Kengeri
  { c: 'BID',  lat: 12.7995, lng: 77.3866 },   // Bidadi
  { c: 'RMGM', lat: 12.7262, lng: 77.2884 },   // Ramanagara
  { c: 'CPT',  lat: 12.6576, lng: 77.2082 },   // Channapatna
  { c: 'MAD',  lat: 12.5851, lng: 77.0434 },   // Maddur
  { c: 'MYA',  lat: 12.5232, lng: 76.8988 },   // Mandya
  { c: 'PANP', lat: 12.4843, lng: 76.6771 },   // Pandavapura
  { c: 'MYS',  lat: 12.3079, lng: 76.6446 },   // Mysuru Jn
];
