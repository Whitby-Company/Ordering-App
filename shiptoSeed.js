// Built-in ship-to addresses for the store customers, matched to customers by
// normalized name and seeded once (see db.js). Line1 = store name, Line2 =
// street; City/State/Zip separate. These feed the ShipTo columns in the TP
// export so the right store address lands on each invoice.

const SHIPTO_SEED = [
  { name: 'Times McCully #1',      line1: 'Times McCully #1',      line2: '1772 South King Street',   city: 'Honolulu',   state: 'HI', zip: '96826', phone: '(808) 973-5868' },
  { name: 'Times - Aiea #9',       line1: 'Times - Aiea #9',       line2: '95-115 Aiea Heights Dr.',  city: 'Aiea',       state: 'HI', zip: '96701', phone: '(808) 483-5088' },
  { name: 'Times Beretania #8',    line1: 'Times Beretania #8',    line2: '1290 S Beretania St.',     city: 'Honolulu',   state: 'HI', zip: '96814', phone: '(808) 532-5400' },
  { name: 'Times Kahala #2',       line1: 'Times Kahala #2',       line2: '1173 21st Ave.',           city: 'Honolulu',   state: 'HI', zip: '96816', phone: '(808) 733-2466' },
  { name: 'Times Kaimuki #14',     line1: 'Times Kaimuki #14',     line2: '3221 Waialae Ave.',        city: 'Honolulu',   state: 'HI', zip: '96816', phone: '(808) 733-5050' },
  { name: 'Times Kam #25',         line1: 'Times Kam #25',         line2: '1620 N. School St.',       city: 'Honolulu',   state: 'HI', zip: '96817', phone: '(808) 564-7260' },
  { name: 'Times Kaneohe #4',      line1: 'Times Kaneohe #4',      line2: '45-934 Kam Hwy',           city: 'Kaneohe',    state: 'HI', zip: '96744', phone: '(808) 233-4622' },
  { name: 'Times Koolau #10',      line1: 'Times Koolau #10',      line2: '47-388 Hui Iwa St.',       city: 'Kaneohe',    state: 'HI', zip: '96744', phone: '(808) 239-8827' },
  { name: 'Times Kunia #18',       line1: 'Times Kunia #18',       line2: '94-615 Kupuohi St.',       city: 'Waipahu',    state: 'HI', zip: '96797', phone: '(808) 678-6565' },
  { name: 'Times Liliha #11',      line1: 'Times Liliha #11',      line2: '1425 Liliha St.',          city: 'Honolulu',   state: 'HI', zip: '96817', phone: '(808) 536-4436' },
  { name: 'Times Mililani #28',    line1: 'Times Mililani #28',    line2: '95-1249 Meheula Prkwy',    city: 'Mililani',   state: 'HI', zip: '96789', phone: '(808) 564-7160' },
  { name: "Times Shima's #21",     line1: "Times Shima's #21",     line2: '41-1606 Kalanianaole Hwy.', city: 'Waimanalo', state: 'HI', zip: '96795', phone: '(808) 259-9921' },
  { name: 'Tokyo Central',         line1: 'Tokyo Central',         line2: '590 Kailua Rd',            city: 'Kailua',     state: 'HI', zip: '96734', phone: '808.266.4004' },
  { name: 'Times Waimalu #12',     line1: 'Times Waimalu #12',     line2: '98-1264 Kaahumanu St',     city: 'Pearl City', state: 'HI', zip: '96782', phone: '(808) 483-3666' },
  { name: 'Times Waipahu #6',      line1: 'Times Waipahu #6',      line2: '94-766 Farrington Hwy',    city: 'Waipahu',    state: 'HI', zip: '',      phone: '(808) 671-0502' },
];

// Normalize a customer/store name for tolerant matching: lowercase, drop every
// character that isn't a letter or digit. "Times - Aiea #9" -> "timesaiea9".
function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

module.exports = { SHIPTO_SEED, normalizeName };
