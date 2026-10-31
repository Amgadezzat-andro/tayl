'use strict';
/** مرجع ISO 4217 للعملات الشائعة: الكود، خانات الوحدة الصغرى، الرمز، الاسم. يُستخدم للاقتراح والتحقق (is_iso). */
module.exports = Object.freeze({
  EGP: [2, 'ج.م', 'جنيه مصري', 'Egyptian pound'], SAR: [2, 'ر.س', 'ريال سعودي', 'Saudi riyal'], AED: [2, 'د.إ', 'درهم إماراتي', 'UAE dirham'],
  KWD: [3, 'د.ك', 'دينار كويتي', 'Kuwaiti dinar'], QAR: [2, 'ر.ق', 'ريال قطري', 'Qatari riyal'], BHD: [3, 'د.ب', 'دينار بحريني', 'Bahraini dinar'],
  OMR: [3, 'ر.ع', 'ريال عماني', 'Omani rial'], JOD: [3, 'د.أ', 'دينار أردني', 'Jordanian dinar'], LBP: [2, 'ل.ل', 'ليرة لبنانية', 'Lebanese pound'],
  IQD: [3, 'د.ع', 'دينار عراقي', 'Iraqi dinar'], SYP: [2, 'ل.س', 'ليرة سورية', 'Syrian pound'], LYD: [3, 'د.ل', 'دينار ليبي', 'Libyan dinar'],
  TND: [3, 'د.ت', 'دينار تونسي', 'Tunisian dinar'], DZD: [2, 'د.ج', 'دينار جزائري', 'Algerian dinar'], MAD: [2, 'د.م', 'درهم مغربي', 'Moroccan dirham'],
  SDG: [2, 'ج.س', 'جنيه سوداني', 'Sudanese pound'], YER: [2, 'ر.ي', 'ريال يمني', 'Yemeni rial'],
  USD: [2, '$', 'دولار أمريكي', 'US dollar'], EUR: [2, '€', 'يورو', 'Euro'], GBP: [2, '£', 'جنيه إسترليني', 'Pound sterling'],
  CHF: [2, 'CHF', 'فرنك سويسري', 'Swiss franc'], JPY: [0, '¥', 'ين ياباني', 'Japanese yen'], CNY: [2, '¥', 'يوان صيني', 'Chinese yuan'],
  INR: [2, '₹', 'روبية هندية', 'Indian rupee'], TRY: [2, '₺', 'ليرة تركية', 'Turkish lira'], CAD: [2, '$', 'دولار كندي', 'Canadian dollar'],
  AUD: [2, '$', 'دولار أسترالي', 'Australian dollar'], RUB: [2, '₽', 'روبل روسي', 'Russian ruble'], XAU: [0, 'XAU', 'ذهب (أوقية)', 'Gold (troy ounce)'],
});
