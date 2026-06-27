export const CATEGORIES = [
  'Verduras',
  'Fruta',
  'Carne magra, pescado blanco y conservas',
  'Pescado y huevo',
  'Embutidos',
  'Lácteos',
  'Carbohidratos y pan',
  'Grasas, frutos secos y semillas',
  'Bebidas vegetales',
  'Salsas y especias',
  'Cacao y chocolate',
  'Suplementos',
  'Otros',
];

export const CATEGORY_ICON = {
  'Verduras': '🥬',
  'Fruta': '🍎',
  'Carne magra, pescado blanco y conservas': '🍗',
  'Pescado y huevo': '🐟',
  'Embutidos': '🥓',
  'Lácteos': '🧀',
  'Carbohidratos y pan': '🍞',
  'Grasas, frutos secos y semillas': '🥑',
  'Bebidas vegetales': '🥛',
  'Salsas y especias': '🧂',
  'Cacao y chocolate': '🍫',
  'Suplementos': '💊',
  'Otros': '📦',
};

export function slug(s){
  return s.normalize('NFD').replace(/[̀-ͯ]/g,'')
    .toLowerCase()
    .replace(/[()%/]/g,' ')
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/^-+|-+$/g,'');
}

// Fallback name → category usado solo cuando un ingrediente no esté en cloud.categories.
// Se mantiene para que la semilla inicial categorice correctamente y para legacy.
const NAME_TO_CATEGORY = {
  'Verdura a elegir':'Verduras','Tomate cherry':'Verduras','Pepino':'Verduras','Espinaca':'Verduras',
  'Lechuga':'Verduras','Cebolla':'Verduras','Setas':'Verduras','Champiñón':'Verduras','Calabacín':'Verduras',
  'Pimiento rojo':'Verduras','Pimiento verde':'Verduras','Tomate':'Verduras','Maíz':'Verduras',
  'Edamame':'Verduras','Pepinillo en vinagre':'Verduras','Gazpacho':'Verduras','Tomate triturado':'Verduras',
  'Arándanos':'Fruta','Kiwi':'Fruta','Fresas':'Fruta','Plátano':'Fruta','Mandarina':'Fruta',
  'Manzana':'Fruta','Mango':'Fruta','Uvas':'Fruta','Limón':'Fruta','Nísperos':'Fruta','Fruta':'Fruta',
  'Pechuga de pollo':'Carne magra, pescado blanco y conservas','Contramuslo de pollo':'Carne magra, pescado blanco y conservas',
  'Filete de ternera':'Carne magra, pescado blanco y conservas','Pechuga de pavo':'Carne magra, pescado blanco y conservas',
  'Atún claro al natural (Dia)':'Carne magra, pescado blanco y conservas','Atún claro al natural (Carrefour)':'Carne magra, pescado blanco y conservas',
  'Sardina':'Carne magra, pescado blanco y conservas','Lentejas cocidas en bote':'Carne magra, pescado blanco y conservas',
  'Garbanzos cocidos':'Carne magra, pescado blanco y conservas','Proteína no grasa':'Carne magra, pescado blanco y conservas',
  'Huevo':'Pescado y huevo','Salmón':'Pescado y huevo',
  'Lomo embuchado':'Embutidos','Pechuga de pavo 92%':'Embutidos','Jamón cocido':'Embutidos','Jamón curado/serrano':'Embutidos',
  'Yogur griego 0%':'Lácteos','Yogur de proteínas':'Lácteos','Queso feta':'Lácteos','Queso burrata':'Lácteos',
  'Queso mozzarella':'Lácteos','Queso en lonchas light':'Lácteos','Queso cottage':'Lácteos',
  'Leche desnatada':'Lácteos','Leche semidesnatada':'Lácteos',
  'Arroz':'Carbohidratos y pan','Pan de pita':'Carbohidratos y pan','Patatas':'Carbohidratos y pan',
  'Boniato':'Carbohidratos y pan','Tortitas de maíz':'Carbohidratos y pan','Pan de hamburguesa':'Carbohidratos y pan',
  'Pan integral':'Carbohidratos y pan','Base de pizza':'Carbohidratos y pan','Copos de avena':'Carbohidratos y pan',
  'Pasta de lentejas':'Carbohidratos y pan','Carbohidrato a elegir':'Carbohidratos y pan',
  'Aceite de oliva':'Grasas, frutos secos y semillas','Crema de cacahuete':'Grasas, frutos secos y semillas',
  'Chía':'Grasas, frutos secos y semillas','Anacardos':'Grasas, frutos secos y semillas',
  'Nueces':'Grasas, frutos secos y semillas','Pipas de calabaza':'Grasas, frutos secos y semillas',
  'Aguacate':'Grasas, frutos secos y semillas',
  'Bebida de soja 0%':'Bebidas vegetales',
  'Salsa de soja':'Salsas y especias','Mostaza de Dijon':'Salsas y especias','Orégano':'Salsas y especias',
  'Ajo':'Salsas y especias','Perejil':'Salsas y especias',
  'Cacao puro 0%':'Cacao y chocolate','Chocolate negro 85%':'Cacao y chocolate',
  'Creatina':'Suplementos',
};

export function categoryFor(name){
  return NAME_TO_CATEGORY[name] || 'Otros';
}

// Estructuras mutables que el resto del código importa. Se rellenan vía rebuild().
export const CATALOG = {};
export const RECIPE_IDS = new Set();

// Reconstruye CATALOG y RECIPE_IDS desde un plan y un mapa de categorías editable.
// catMap[id] toma prioridad sobre el fallback NAME_TO_CATEGORY.
// Muta cada item del plan añadiéndole `id` (slug del nombre).
export function rebuild(plan, catMap){
  for(const k of Object.keys(CATALOG)) delete CATALOG[k];
  RECIPE_IDS.clear();
  if(!plan) return;
  catMap = catMap || {};
  for(const day of Object.values(plan)){
    if(!day?.meals) continue;
    for(const meal of day.meals){
      if(!meal.items) continue;
      for(const it of meal.items){
        const id = slug(it.n);
        it.id = id;
        const unit = it.u || 'g';
        if(!CATALOG[id]){
          const category = catMap[id] || categoryFor(it.n);
          CATALOG[id] = { name: it.n, unit, category };
        }
        RECIPE_IDS.add(id);
      }
    }
  }
}

// Construye categorías iniciales desde NAME_TO_CATEGORY para semilla inicial.
export function seedCategoriesFromPlan(plan){
  const out = {};
  for(const day of Object.values(plan)){
    if(!day?.meals) continue;
    for(const meal of day.meals){
      if(!meal.items) continue;
      for(const it of meal.items){
        const id = slug(it.n);
        if(!out[id]) out[id] = categoryFor(it.n);
      }
    }
  }
  return out;
}
