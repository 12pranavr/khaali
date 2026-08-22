import { EXTRA_TRAINS } from './extra-trains.mjs';
// Timetable extracted from Rail Booking Flow.dc.html (data.gov.in derived).
// Single source of truth for the server and the client.
export const ST = [
    {n:'Bangarpet',c:'BWT',km:0,pf:2},
    {n:'Whitefield',c:'WFD',km:47,pf:1},
    {n:'K R Puram',c:'KJM',km:56,pf:3},
    {n:'Bengaluru East',c:'BNCE',km:63,pf:1},
    {n:'Bengaluru Cantt',c:'BNC',km:66,pf:2},
    {n:'Bengaluru (KSR City)',c:'SBC',km:70,pf:6},
    {n:'Kengeri',c:'KGI',km:82,pf:1},
    {n:'Bidadi',c:'BID',km:100,pf:2},
    {n:'Ramanagara',c:'RMGM',km:115,pf:1},
    {n:'Channapatna',c:'CPT',km:126,pf:2},
    {n:'Maddur',c:'MAD',km:144,pf:1},
    {n:'Mandya',c:'MYA',km:163,pf:3},
    {n:'Pandavapura',c:'PANP',km:189,pf:1},
    {n:'Mysuru Jn',c:'MYS',km:208,pf:4}
  ];

export const CLS = [
    {k:'SL',label:'Sleeper',coaches:['S1','S2','S3','S4','S5','S6'],per:72,free:1,vac:52,rate:.55,base:60},
    {k:'3A',label:'AC 3 Tier',coaches:['B1','B2','B3'],per:64,free:3,vac:24,rate:2.1,base:190},
    {k:'2A',label:'AC 2 Tier',coaches:['A1','A2'],per:48,free:2,vac:11,rate:3.0,base:310}
  ];

const CORE = [
    {no:'16021',name:'Kaveri Express',dir:1,stops:{0:['01:53','01:55',0],1:['02:29','02:30',0],2:['02:38','02:40',0],3:['02:49','02:50',0],4:['02:58','03:00',0],5:['03:45','04:00',0],6:['04:19','04:20',0],7:['04:35','04:36',0],8:['04:44','04:45',0],9:['04:54','04:55',0],10:['05:14','05:15',0],11:['05:34','05:35',0],12:['05:59','06:00',0],13:['06:50',null,0]}},
    {no:'22682',name:'Chennai\u2013Mysuru Express',dir:1,stops:{0:['03:48','03:50',0],2:['04:43','04:45',0],4:['04:48','05:00',0],5:['05:30','05:40',0],6:['05:57','05:58',0],11:['06:58','07:00',0],13:['08:20',null,0]}},
    {no:'22817',name:'Howrah\u2013Mysuru Superfast',dir:1,stops:{0:['22:53','22:55',0],2:['23:43','23:45',0],5:['00:30','01:00',1],13:['03:45',null,1]}},
    {no:'16022',name:'Kaveri Express',dir:-1,stops:{13:[null,'20:30',0],12:['20:49','20:50',0],11:['21:08','21:10',0],10:['21:29','21:30',0],9:['21:44','21:45',0],8:['21:59','22:00',0],6:['22:23','22:35',0],5:['23:25','23:45',0],4:['23:55','23:57',0],2:['00:08','00:10',1],1:['00:23','00:24',1],0:['01:08','01:10',1]}},
    {no:'22681',name:'Mysuru\u2013Chennai Express',dir:-1,stops:{13:[null,'20:10',0],11:['20:48','20:50',0],6:['22:08','22:10',0],5:['22:45','23:00',0],4:['23:10','23:12',0],2:['23:21','23:23',0],0:['00:13','00:15',1]}},
    {no:'22818',name:'Mysuru\u2013Howrah Superfast',dir:-1,stops:{13:[null,'00:30',0],5:['02:50','03:10',0],2:['03:33','03:35',0],0:['04:18','04:20',0]}}
  ];

// The six flagship trains keep their photos and colours; everything from the
// public timetable joins them as fully bookable services.
export const CORE_TRAINS = CORE;
export const TRAINS = CORE.map(t => ({ ...t, core: true })).concat(EXTRA_TRAINS);
