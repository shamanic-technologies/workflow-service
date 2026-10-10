/**
 * WORKFLOWS ARE STARS. Owner decision 2026-10-10: every named object in distribute.you reads as ONE
 * family per concept, so a name alone says what kind of thing it is. Sales Funnels are uplifting words,
 * Pipes are birds, Sales Paths are rivers (all three owned by features-service), Workflows are stars.
 *
 * A new workflow dynasty's `workflow_dynasty_signature_name` is drawn from the IAU Catalog of Star Names
 * (WGSN, https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt, edition 2022-04-04): the
 * 427 single-word ASCII names (the 24 multi-word names such as "Kaus Australis" are left out), minus
 * the names in `EXCLUDED_STAR_NAMES`, each with its reason: a common English word, a word of a
 * features-service family (uplifting words, birds, rivers), a person, or a place that reads as the place.
 *
 * Once every single star name is burned for a feature, the pick moves to a TWO-WORD form, a positive
 * adjective and a star ("bright-vega", displayed "Bright Vega"). When those run out too, the pick
 * THROWS: no numeric suffix, no reused name, no word from another family.
 *
 * Names given before 2026-10-10 came from a mixed pool (trees, minerals, animals, ...). They stay
 * exactly as they are: a name is burned for life, and the caller passes every name its feature ever
 * used, whatever pool it came from.
 */

/** IAU-CSN 2022-04-04, single-word ASCII names, alphabetical. Pinned by tests: do not edit by hand. */
export const IAU_SINGLE_WORD_STAR_NAMES: readonly string[] = [
  "Absolutno", "Acamar", "Achernar", "Achird", "Acrab", "Acrux", "Acubens", "Adhafera",
  "Adhara", "Adhil", "Ain", "Ainalrami", "Aladfar", "Alasia", "Albaldah", "Albali", "Albireo",
  "Alchiba", "Alcor", "Alcyone", "Aldebaran", "Alderamin", "Aldhanab", "Aldhibah", "Aldulfin",
  "Alfirk", "Algedi", "Algenib", "Algieba", "Algol", "Algorab", "Alhena", "Alioth", "Aljanah",
  "Alkaid", "Alkalurops", "Alkaphrah", "Alkarab", "Alkes", "Almaaz", "Almach", "Alnair",
  "Alnasl", "Alnilam", "Alnitak", "Alniyat", "Alphard", "Alphecca", "Alpheratz", "Alpherg",
  "Alrakis", "Alrescha", "Alruba", "Alsafi", "Alsciaukat", "Alsephina", "Alshain", "Alshat",
  "Altair", "Altais", "Alterf", "Aludra", "Alya", "Alzirr", "Amadioha", "Amansinaya", "Anadolu",
  "Ancha", "Angetenar", "Aniara", "Ankaa", "Anser", "Antares", "Arcalis", "Arcturus", "Arneb",
  "Ascella", "Ashlesha", "Aspidiske", "Asterope", "Atakoraka", "Athebyne", "Atik", "Atlas",
  "Atria", "Avior", "Axolotl", "Ayeyarwady", "Azelfafage", "Azha", "Azmidi", "Baekdu", "Beemim",
  "Beid", "Belel", "Belenos", "Bellatrix", "Berehynia", "Betelgeuse", "Bharani", "Bibha",
  "Biham", "Bosona", "Botein", "Brachium", "Bubup", "Buna", "Bunda", "Canopus", "Capella",
  "Caph", "Castor", "Castula", "Cebalrai", "Ceibo", "Celaeno", "Cervantes", "Chalawan",
  "Chamukuy", "Chaophraya", "Chara", "Chason", "Chechia", "Chertan", "Citadelle", "Citala",
  "Cocibolca", "Copernicus", "Cujam", "Cursa", "Dabih", "Dalim", "Deneb", "Denebola", "Diadem",
  "Dingolay", "Diphda", "Diwo", "Diya", "Dofida", "Dombay", "Dschubba", "Dubhe", "Dziban",
  "Ebla", "Edasich", "Electra", "Elgafar", "Elkurud", "Elnath", "Eltanin", "Emiw", "Enif",
  "Errai", "Fafnir", "Fang", "Fawaris", "Felis", "Felixvarela", "Flegetonte", "Fomalhaut",
  "Formosa", "Franz", "Fulu", "Fumalsamakah", "Funi", "Furud", "Fuyue", "Gacrux", "Gakyid",
  "Geminga", "Giausar", "Gienah", "Ginan", "Gloas", "Gomeisa", "Grumium", "Gudja", "Gumala",
  "Guniibuu", "Hadar", "Haedus", "Hamal", "Hassaleh", "Hatysa", "Helvetios", "Heze", "Hoggar",
  "Homam", "Horna", "Hunahpu", "Hunor", "Iklil", "Illyrian", "Imai", "Inquill", "Intan",
  "Intercrus", "Irena", "Itonda", "Izar", "Jabbah", "Jishui", "Kaffaljidhma", "Kalausi",
  "Kamuy", "Kang", "Karaka", "Kaveh", "Keid", "Khambalia", "Kitalpha", "Kochab", "Koeia",
  "Koit", "Kornephoros", "Kraz", "Kurhah", "Larawag", "Lerna", "Lesath", "Libertas", "Lich",
  "Liesma", "Lionrock", "Lucilinburhuc", "Lusitania", "Maasym", "Macondo", "Mago", "Mahasim",
  "Mahsati", "Maia", "Malmok", "Marfik", "Markab", "Markeb", "Marohu", "Marsic", "Matar",
  "Mazaalai", "Mebsuta", "Megrez", "Meissa", "Mekbuda", "Meleph", "Menkalinan", "Menkar",
  "Menkent", "Menkib", "Merak", "Merga", "Meridiana", "Merope", "Mesarthim", "Miaplacidus",
  "Mimosa", "Minchir", "Minelauva", "Mintaka", "Mira", "Mirach", "Miram", "Mirfak", "Mirzam",
  "Misam", "Mizar", "Moldoveanu", "Monch", "Montuno", "Morava", "Moriah", "Mothallah",
  "Mouhoun", "Mpingo", "Muliphein", "Muphrid", "Muscida", "Musica", "Muspelheim", "Nahn",
  "Naledi", "Naos", "Nashira", "Nasti", "Natasha", "Nekkar", "Nembus", "Nenque", "Nervia",
  "Nganurganity", "Nihal", "Nikawiy", "Nosaxa", "Nunki", "Nusakan", "Nushagak", "Nyamien",
  "Ogma", "Okab", "Paikauhale", "Parumleo", "Peacock", "Petra", "Phact", "Phecda", "Pherkad",
  "Phoenicia", "Piautos", "Pincoya", "Pipirima", "Pipoltr", "Pleione", "Poerava", "Polaris",
  "Polis", "Pollux", "Porrima", "Praecipua", "Procyon", "Propus", "Ran", "Rana", "Rapeto",
  "Rasalas", "Rasalgethi", "Rasalhague", "Rastaban", "Regulus", "Revati", "Rigel",
  "Rosaliadecastro", "Rotanev", "Ruchbah", "Rukbat", "Sabik", "Saclateni", "Sadachbia",
  "Sadalbari", "Sadalmelik", "Sadalsuud", "Sadr", "Sagarmatha", "Saiph", "Salm", "Samaya",
  "Sansuna", "Sargas", "Sarin", "Sceptrum", "Scheat", "Schedar", "Segin", "Seginus", "Sham",
  "Shama", "Sharjah", "Shaula", "Sheliak", "Sheratan", "Sika", "Sirius", "Situla", "Skat",
  "Solaris", "Spica", "Sterrennacht", "Stribor", "Sualocin", "Subra", "Suhail", "Sulafat",
  "Syrma", "Tabit", "Taika", "Taiyangshou", "Taiyi", "Talitha", "Tangra", "Tapecue", "Tarazed",
  "Tarf", "Taygeta", "Tegmine", "Tejat", "Terebellum", "Tevel", "Theemin", "Thuban", "Tiaki",
  "Tianguan", "Tianyi", "Timir", "Tislit", "Titawin", "Tojil", "Toliman", "Tonatiuh",
  "Torcular", "Tuiren", "Tupa", "Tupi", "Tureis", "Ukdah", "Uklun", "Unukalhai", "Uruk", "Vega",
  "Veritate", "Vindemiatrix", "Wasat", "Wazn", "Wezen", "Wurren", "Xamidimura", "Xihe",
  "Xuange", "Yildun", "Zaniah", "Zaurak", "Zavijava", "Zhang", "Zibal", "Zosma",
  "Zubenelgenubi", "Zubenelhakrabi", "Zubeneschamali",
];

/** IAU names we never give a workflow, with the reason. Each one must exist in the IAU list above. */
export const EXCLUDED_STAR_NAMES: Readonly<Record<string, string>> = {
  Atlas: "English word",
  Castor: "English word",
  Fang: "English word",
  Lich: "English word",
  Polis: "English word",
  Ran: "English word",
  Sham: "English word",
  Sarin: "English word (a nerve agent)",
  Skat: "English word (a card game)",
  Situla: "English word (a bucket)",
  Brachium: "English word (anatomy)",
  Mimosa: "English word (a plant, a cocktail)",
  Kang: "English word",
  Musica: "reads as music",
  Diadem: "features-service SALES_PATH_NAME_POOL",
  Polaris: "features-service SALES_PATH_NAME_POOL",
  Peacock: "a bird",
  Anser: "a bird (goose genus)",
  Shama: "a bird",
  Axolotl: "an animal",
  Felis: "an animal (cat genus)",
  Rana: "an animal (frog genus)",
  Sika: "an animal (a deer)",
  Mazaalai: "an animal (Gobi bear)",
  Mpingo: "a tree",
  Ceibo: "a tree",
  Ayeyarwady: "a river",
  Chaophraya: "a river",
  Mouhoun: "a river",
  Nushagak: "a river",
  Morava: "a river",
  Buna: "a river",
  Bosona: "a river",
  Nervia: "a river",
  Flegetonte: "a river",
  Cocibolca: "a lake",
  Tislit: "a lake",
  Franz: "a person's name",
  Natasha: "a person's name",
  Irena: "a person's name",
  Cervantes: "a person",
  Copernicus: "a person",
  Felixvarela: "a person",
  Rosaliadecastro: "a person",
  Sharjah: "a city",
  Formosa: "a place",
  Phoenicia: "a place",
  Lusitania: "a place",
  Anadolu: "a place",
  Illyrian: "a people",
  Helvetios: "a people",
  Sagarmatha: "a mountain (Everest)",
  Uruk: "a city",
  Ebla: "a city",
  Moriah: "a place",
  Petra: "a city",
  Lucilinburhuc: "a city (Luxembourg)",
  Macondo: "a fictional town",
};

/** Positive adjectives for the two-word form. None is a word of a features-service family. */
export const STAR_NAME_ADJECTIVES: readonly string[] = [
  "Bright", "Bold", "Brave", "Calm", "Clear", "Fair", "Keen", "Kind", "Glad", "Warm",
  "True", "Wise", "Steady", "Gentle", "Lucky", "Merry", "Grand", "Pure", "Proud", "Twinkling",
];

/** Single star names a new dynasty may receive, lowercase (the stored, slug-safe form). */
export const STAR_NAME_POOL: readonly string[] = IAU_SINGLE_WORD_STAR_NAMES
  .filter((name) => !(name in EXCLUDED_STAR_NAMES))
  .map((name) => name.toLowerCase());

const ADJECTIVES_LOWER = STAR_NAME_ADJECTIVES.map((a) => a.toLowerCase());
const TWO_WORD_COUNT = ADJECTIVES_LOWER.length * STAR_NAME_POOL.length;

export class WorkflowDynastySignatureNamePoolExhaustedError extends Error {
  constructor(public readonly burnedCount: number) {
    super(
      `[workflow-service] workflow dynasty signature name pool exhausted: ${burnedCount} names are burned on this feature and every star name and adjective + star pair is taken. Add star names or adjectives to src/lib/workflow-dynasty-signature-name.ts`,
    );
    this.name = "WorkflowDynastySignatureNamePoolExhaustedError";
  }
}

/**
 * Picks a workflow_dynasty_signature_name for a NEW dynasty. Deterministic on the DAG signature: the
 * hash picks a start index, and a name burned on the feature is skipped by walking forward. Single
 * star names first, then adjective + star ("bright-vega"). Throws when both tiers are exhausted.
 */
export function pickWorkflowDynastySignatureName(
  signature: string,
  existingWorkflowDynastySignatureNamesForFeature: Set<string>,
): string {
  const seed = parseInt(signature.slice(0, 8), 16);
  if (Number.isNaN(seed)) {
    throw new Error(`[workflow-service] DAG signature is not a hex hash: "${signature}"`);
  }
  const burned = existingWorkflowDynastySignatureNamesForFeature;

  const singles = STAR_NAME_POOL.length;
  for (let offset = 0; offset < singles; offset++) {
    const name = STAR_NAME_POOL[(seed + offset) % singles];
    if (!burned.has(name)) return name;
  }

  for (let offset = 0; offset < TWO_WORD_COUNT; offset++) {
    const index = (seed + offset) % TWO_WORD_COUNT;
    const adjective = ADJECTIVES_LOWER[index % ADJECTIVES_LOWER.length];
    const star = STAR_NAME_POOL[Math.floor(index / ADJECTIVES_LOWER.length)];
    const name = `${adjective}-${star}`;
    if (!burned.has(name)) return name;
  }

  throw new WorkflowDynastySignatureNamePoolExhaustedError(burned.size);
}

/** "vega" -> "Vega", "bright-vega" -> "Bright Vega": the signature name as it reads in a dynasty name. */
export function workflowDynastySignatureNameToDisplay(workflowDynastySignatureName: string): string {
  return workflowDynastySignatureName
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Exported for testing */
export const WORD_COUNT = STAR_NAME_POOL.length;
export const TWO_WORD_NAME_COUNT = TWO_WORD_COUNT;
