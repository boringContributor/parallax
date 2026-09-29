/** Horizons ID → mission metadata shown in the info card. Positions always come from JPL Horizons. */
export interface MissionMeta {
  short: string;
  agency: string;
  launched: string;
  color: string;
  about: string;
  url: string;
}

export const MISSIONS: Record<string, MissionMeta> = {
  '-31': { short: 'Voyager 1', agency: 'NASA', launched: '1977', color: '#ffd166', url: 'https://science.nasa.gov/mission/voyager/',
    about: 'The most distant human-made object. Crossed the heliopause into interstellar space in August 2012 and still returns data from beyond the Sun’s bubble.' },
  '-32': { short: 'Voyager 2', agency: 'NASA', launched: '1977', color: '#f4a261', url: 'https://science.nasa.gov/mission/voyager/',
    about: 'The only spacecraft to visit Uranus and Neptune. Entered interstellar space in November 2018.' },
  '-98': { short: 'New Horizons', agency: 'NASA', launched: '2006', color: '#90e0ef', url: 'https://science.nasa.gov/mission/new-horizons/',
    about: 'Flew past Pluto in 2015 and the Kuiper Belt object Arrokoth in 2019; now exploring the outer heliosphere.' },
  '-96': { short: 'Parker Solar Probe', agency: 'NASA', launched: '2018', color: '#ff7b54', url: 'https://science.nasa.gov/mission/parker-solar-probe/',
    about: 'Dives through the Sun’s corona. Its closest perihelia (≈6.1 million km from the surface) make it the fastest object ever built.' },
  '-61': { short: 'Juno', agency: 'NASA', launched: '2011', color: '#e9c46a', url: 'https://science.nasa.gov/mission/juno/',
    about: 'Polar orbiter studying Jupiter’s interior, magnetosphere and moons since 2016.' },
  '-159': { short: 'Europa Clipper', agency: 'NASA', launched: '2024', color: '#8ecae6', url: 'https://science.nasa.gov/mission/europa-clipper/',
    about: 'Cruising to Jupiter (arrival 2030) to investigate whether the ocean beneath Europa’s ice could support life. Uses Mars and Earth gravity assists on the way.' },
  '-28': { short: 'JUICE', agency: 'ESA', launched: '2023', color: '#a3b18a', url: 'https://www.esa.int/Science_Exploration/Space_Science/Juice',
    about: 'JUpiter ICy moons Explorer: a multi-flyby cruise (Moon, Earth, Venus, Earth, Earth) toward Jupiter in 2031, ending in orbit around Ganymede.' },
  '-121': { short: 'BepiColombo', agency: 'ESA / JAXA', launched: '2018', color: '#c77dff', url: 'https://www.esa.int/Science_Exploration/Space_Science/BepiColombo',
    about: 'Two orbiters travelling together to Mercury after a long sequence of Earth, Venus and Mercury flybys.' },
  '-255': { short: 'Psyche', agency: 'NASA', launched: '2023', color: '#b5838d', url: 'https://science.nasa.gov/mission/psyche/',
    about: 'Electric-propulsion cruise to the metal-rich asteroid 16 Psyche, arriving in 2029.' },
  '-49': { short: 'Lucy', agency: 'NASA', launched: '2021', color: '#ffafcc', url: 'https://science.nasa.gov/mission/lucy/',
    about: 'First mission to Jupiter’s Trojan asteroids, touring several of them from 2027 onwards.' },
  '-91': { short: 'Hera', agency: 'ESA', launched: '2024', color: '#80ed99', url: 'https://www.esa.int/Space_Safety/Hera',
    about: 'Planetary-defence follow-up to NASA’s DART impact: travelling to the Didymos–Dimorphos binary asteroid to measure the aftermath.' },
  '-144': { short: 'Solar Orbiter', agency: 'ESA / NASA', launched: '2020', color: '#ffb703', url: 'https://www.esa.int/Science_Exploration/Space_Science/Solar_Orbiter',
    about: 'Uses Venus flybys to tilt its orbit and take the first images of the Sun’s poles.' },
  '-64': { short: 'OSIRIS-APEX', agency: 'NASA', launched: '2016', color: '#d4a373', url: 'https://science.nasa.gov/mission/osiris-apex/',
    about: 'Formerly OSIRIS-REx, which returned samples of asteroid Bennu in 2023. Now headed for asteroid Apophis after its close Earth flyby in 2029.' },
  '-37': { short: 'Hayabusa2', agency: 'JAXA', launched: '2014', color: '#ade8f4', url: 'https://www.hayabusa2.jaxa.jp/en/',
    about: 'Returned samples of asteroid Ryugu in 2020; its extended mission continues toward small near-Earth asteroids.' },
  '-234': { short: 'STEREO-A', agency: 'NASA', launched: '2006', color: '#f9c74f', url: 'https://science.nasa.gov/mission/stereo/',
    about: 'Watches the Sun from a vantage point along Earth’s orbit, giving a second angle on solar storms.' },
  '-74': { short: 'MRO', agency: 'NASA', launched: '2005', color: '#e76f51', url: 'https://science.nasa.gov/mission/mars-reconnaissance-orbiter/',
    about: 'Mars Reconnaissance Orbiter: high-resolution imaging of Mars and a key relay for surface missions.' },
  '-62': { short: 'Hope (EMM)', agency: 'UAE Space Agency', launched: '2020', color: '#e63946', url: 'https://www.emiratesmarsmission.ae/',
    about: 'Emirates Mars Mission: studies the Martian atmosphere and weather from a high orbit.' },
  '-170': { short: 'JWST', agency: 'NASA / ESA / CSA', launched: '2021', color: '#ffd60a', url: 'https://science.nasa.gov/mission/webb/',
    about: 'James Webb Space Telescope: infrared observatory on a halo orbit around the Sun–Earth L2 point, 1.5 million km beyond Earth.' },
  '-680': { short: 'Euclid', agency: 'ESA', launched: '2023', color: '#caf0f8', url: 'https://www.esa.int/Science_Exploration/Space_Science/Euclid',
    about: 'Mapping billions of galaxies from Sun–Earth L2 to probe dark matter and dark energy.' },
  '-21': { short: 'SOHO', agency: 'ESA / NASA', launched: '1995', color: '#ffc300', url: 'https://soho.nascom.nasa.gov/',
    about: 'Solar and Heliospheric Observatory at Sun–Earth L1. Also the most prolific comet discoverer in history.' },
};
