import { DATA } from './data.js';

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

// Mapeo nombre → categoría canónica. Mantener aquí las excepciones.
const NAME_TO_CATEGORY = {
  // Verduras
  'Verdura a elegir':'Verduras','Tomate cherry':'Verduras','Pepino':'Verduras','Espinaca':'Verduras',
  'Lechuga':'Verduras','Cebolla':'Verduras','Setas':'Verduras','Champiñón':'Verduras','Calabacín':'Verduras',
  'Pimiento rojo':'Verduras','Pimiento verde':'Verduras','Tomate':'Verduras','Maíz':'Verduras',
  'Edamame':'Verduras','Pepinillo en vinagre':'Verduras','Gazpacho':'Verduras','Tomate triturado':'Verduras',
  // Fruta
  'Arándanos':'Fruta','Kiwi':'Fruta','Fresas':'Fruta','Plátano':'Fruta','Mandarina':'Fruta',
  'Manzana':'Fruta','Mango':'Fruta','Uvas':'Fruta','Limón':'Fruta','Nísperos':'Fruta','Fruta':'Fruta',
  // Carne magra, pescado blanco y conservas
  'Pechuga de pollo':'Carne magra, pescado blanco y conservas','Contramuslo de pollo':'Carne magra, pescado blanco y conservas',
  'Filete de ternera':'Carne magra, pescado blanco y conservas','Pechuga de pavo':'Carne magra, pescado blanco y conservas',
  'Atún claro al natural (Dia)':'Carne magra, pescado blanco y conservas','Atún claro al natural (Carrefour)':'Carne magra, pescado blanco y conservas',
  'Sardina':'Carne magra, pescado blanco y conservas','Lentejas cocidas en bote':'Carne magra, pescado blanco y conservas',
  'Garbanzos cocidos':'Carne magra, pescado blanco y conservas','Proteína no grasa':'Carne magra, pescado blanco y conservas',
  // Pescado y huevo
  'Huevo':'Pescado y huevo','Salmón':'Pescado y huevo',
  // Embutidos
  'Lomo embuchado':'Embutidos','Pechuga de pavo 92%':'Embutidos','Jamón cocido':'Embutidos','Jamón curado/serrano':'Embutidos',
  // Lácteos
  'Yogur griego 0%':'Lácteos','Yogur de proteínas':'Lácteos','Queso feta':'Lácteos','Queso burrata':'Lácteos',
  'Queso mozzarella':'Lácteos','Queso en lonchas light':'Lácteos','Queso cottage':'Lácteos',
  'Leche desnatada':'Lácteos','Leche semidesnatada':'Lácteos',
  // Carbohidratos y pan
  'Arroz':'Carbohidratos y pan','Pan de pita':'Carbohidratos y pan','Patatas':'Carbohidratos y pan',
  'Boniato':'Carbohidratos y pan','Tortitas de maíz':'Carbohidratos y pan','Pan de hamburguesa':'Carbohidratos y pan',
  'Pan integral':'Carbohidratos y pan','Base de pizza':'Carbohidratos y pan','Copos de avena':'Carbohidratos y pan',
  'Pasta de lentejas':'Carbohidratos y pan','Carbohidrato a elegir':'Carbohidratos y pan',
  // Grasas, frutos secos y semillas
  'Aceite de oliva':'Grasas, frutos secos y semillas','Crema de cacahuete':'Grasas, frutos secos y semillas',
  'Chía':'Grasas, frutos secos y semillas','Anacardos':'Grasas, frutos secos y semillas',
  'Nueces':'Grasas, frutos secos y semillas','Pipas de calabaza':'Grasas, frutos secos y semillas',
  'Aguacate':'Grasas, frutos secos y semillas',
  // Bebidas vegetales
  'Bebida de soja 0%':'Bebidas vegetales',
  // Salsas y especias
  'Salsa de soja':'Salsas y especias','Mostaza de Dijon':'Salsas y especias','Orégano':'Salsas y especias',
  'Ajo':'Salsas y especias','Perejil':'Salsas y especias',
  // Cacao y chocolate
  'Cacao puro 0%':'Cacao y chocolate','Chocolate negro 85%':'Cacao y chocolate',
  // Suplementos
  'Creatina':'Suplementos',
};

export function categoryFor(name){
  return NAME_TO_CATEGORY[name] || 'Otros';
}

// catalog[id] = { name, unit, category }
export const CATALOG = {};
// Ids derivados de las recetas (no incluyen los añadidos a mano en despensa).
export const RECIPE_IDS = new Set();

(function build(){
  for(const day of Object.values(DATA)){
    for(const meal of day.meals){
      if(!meal.items) continue;
      for(const it of meal.items){
        const id = slug(it.n);
        it.id = id;
        const unit = it.u || 'g';
        if(!CATALOG[id]){
          CATALOG[id] = { name: it.n, unit, category: categoryFor(it.n) };
        }
        RECIPE_IDS.add(id);
      }
    }
  }
})();
