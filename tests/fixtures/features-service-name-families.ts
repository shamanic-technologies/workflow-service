/**
 * Snapshot of the name families features-service owns, so a workflow (star) name can never read as one
 * of them. Uplifting words = `SALES_PATH_NAME_POOL` in features-service `src/lib/sales-path-names.ts`
 * (origin/main 16dc4236b, 2026-10-10, 208 words). When features-service adds words, or ships its
 * bird / river pools, append them here: the star-pool test fails on any overlap.
 */
export const FEATURES_SERVICE_UPLIFTING_WORDS: readonly string[] = [
  "Victory", "Sol", "Herald", "Epiphany", "Triumph", "Zenith", "Summit", "Glory", "Aurora",
  "Bounty", "Jubilee", "Radiance", "Apex", "Laurel", "Harvest", "Eureka", "Halo", "Crown",
  "Pinnacle", "Ascent", "Bliss", "Splendor", "Fortune", "Valor", "Anthem", "Beacon", "Comet",
  "Dawn", "Elation", "Encore", "Euphoria", "Fanfare", "Flourish", "Gala", "Gleam", "Golden",
  "Grace", "Honor", "Horizon", "Jackpot", "Joy", "Jubilation", "Lumen", "Luster", "Majesty",
  "Marvel", "Meridian", "Miracle", "Nova", "Oasis", "Opulence", "Ovation", "Paragon", "Plenty",
  "Prism", "Prodigy", "Rapture", "Regal", "Rise", "Rhapsody", "Riches", "Soar", "Solstice",
  "Sovereign", "Sparkle", "Spire", "Starlight", "Sterling", "Sunrise", "Sunburst", "Supernova",
  "Thrive", "Tiara", "Titan", "Torch", "Treasure", "Trophy", "Upswing", "Utopia", "Vanguard",
  "Verve", "Vista", "Wonder", "Zeal", "Zest", "Abundance", "Acclaim", "Accolade", "Ardor",
  "Aspire", "Bonanza", "Brilliance", "Cascade", "Celebration", "Champion", "Cheer", "Clarion",
  "Crescendo", "Delight", "Destiny", "Diadem", "Dynamo", "Eden", "Elevate", "Elysium", "Emblem",
  "Empyrean", "Exalt", "Excelsior", "Fiesta", "Flair", "Fervor", "Gem", "Genesis", "Gilded",
  "Glimmer", "Glow", "Gusto", "Harmony", "Heyday", "Hurrah", "Icon", "Ignite", "Jewel", "Kudos",
  "Legend", "Lodestar", "Magnum", "Mirth", "Momentum", "Monarch", "Noble", "Olympus", "Panache",
  "Paradise", "Pearl", "Phoenix", "Plaudit", "Polaris", "Premier", "Prestige", "Promise",
  "Providence", "Rainbow", "Renown", "Revel", "Ruby", "Saga", "Sapphire", "Serenade", "Shine",
  "Skyward", "Sonnet", "Spark", "Stellar", "Sublime", "Success", "Sunbeam", "Surge", "Talisman",
  "Tribute", "Uplift", "Vantage", "Verdant", "Victor", "Vivid", "Windfall", "Wish", "Amber",
  "Aria", "Bravo", "Cadence", "Cosmos", "Dazzle", "Echelon", "Ember", "Emerald", "Fable",
  "Festival", "Luminary", "Gallant", "Garland", "Glee", "Grandeur", "Hallmark", "Heaven",
  "Hero", "Idyll", "Jasmine", "Kindle", "Lyric", "Medal", "Merit", "Nectar", "Opal", "Orbit",
  "Peak", "Pride", "Quasar", "Radiant", "Rally", "Reign", "Resound", "Sunlit", "Topaz", "Unity",
  "Velvet", "Zephyr",
];

/** Birds and rivers that are ALSO IAU star names: the ones the star pool must exclude. */
export const BIRD_AND_RIVER_STAR_NAMES: readonly string[] = [
  "Peacock", "Anser", "Shama",
  "Ayeyarwady", "Chaophraya", "Mouhoun", "Nushagak", "Morava", "Buna", "Bosona", "Nervia", "Flegetonte",
];
