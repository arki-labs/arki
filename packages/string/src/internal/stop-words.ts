/** Function words per language, lowercased, for `keywords()`. */

export type KeywordLanguage = 'en' | 'es' | 'de' | 'fr' | 'ro';

const split = (text: string): readonly string[] => Object.freeze(text.trim().split(/\s+/u));

export const ENGLISH = split(`
a about above after all also am an and any are as at be because been before being below between both but by
can could did do does down during each either every few for from get got had has have he her hers him his how
i if in into is it its just least less like many may me might mine more most much must neither no not of off on
one only onto or other our ours out over several shall she should so some such than that the their theirs them
then there these they this those through to too under up upon us very was we were what when where which while who
whom why will with within without would yes you your yours`);

export const SPANISH = split(`
a al algo alguna algunas alguno algunos ante antes aquel aquella aquellas aquellos aquí así aunque cada casi como
con contra cual cuales cuando de del desde donde dos durante e el ella ellas ellos en entre era eran es esa esas
ese eso esos esta estaba estamos estar estas este esto estos están fue fueron ha había hace hacia han hasta hay la
las le les lo los me mi mis mucho muchos muy más ni no nos nosotros nuestra nuestras nuestro nuestros o os otra
otras otro otros para pero poco por porque que quien quienes qué se sea ser si sido sin sobre son soy su sus sí
también tanto te tener tiene tienen toda todas todo todos tu tus tú un una unas uno unos usted ustedes vosotras
vosotros vuestra vuestras vuestro vuestros y ya yo él`);

export const GERMAN = split(`
aber alle allem allen aller alles als also am an andere anderen anderer anderes auch auf aus bei bin bis bist da
damit dann das dass dein deine dem den denn der deren des dessen dich die dies diese diesem diesen dieser dieses
dir doch dort du durch ein eine einem einen einer eines er es etwas euch euer eure für gegen gewesen hab habe haben
hat hatte hatten hier hin hinter ich ihm ihn ihnen ihr ihre ihrem ihren ihrer ihres im in indem ins ist jede jedem
jeden jeder jedes jene jenem jenen jener jenes jetzt kann kein keine keinem keinen keiner keines können könnte
machen man manche manchem manchen mancher manches mein meine meinem meinen meiner meines mit muss musste nach nicht
nichts noch nun nur ob oder ohne sehr sein seine seinem seinen seiner seines selbst sich sie sind so solche solchem
solchen solcher solches soll sollte sondern sonst um und uns unse unsem unsen unser unses unter viel vom von vor
war waren warst was weg weil weiter welche welchem welchen welcher welches wenn werde werden wie wieder will wir
wird wirst wo wollen wollte während würde würden zu zum zur zwar zwischen über`);

export const FRENCH = split(`
a afin ai aie alors après as au aucun aussi autre aux avant avec avoir bien car ce cela celle celles celui ces cet
cette ceux chaque chez comme comment dans de des donc dont du elle elles en encore entre est et eu eux faire fait
fois font ici il ils je la le les leur leurs lui ma mais me mes moi mon même ne ni nos notre nous on ont ou où par
parce pas peu plus pour pourquoi quand que quel quelle quelles quels qui sa sans se ses si sien son sont sous sur
ta te tes toi ton tous tout toute toutes très tu un une vers voici voilà vos votre vous y à été être ça`);

export const ROMANIAN = split(`
a abia acea aceasta această aceea acei aceia acel acela acele acelea acest acesta aceste acestea aceşti aceștia
acolo acum ai aia aibă aici al ale alea alt alta altceva altcineva alte altfel alţi alții am ar are asemenea asta
astea astfel asupra atare atât atâta atâtea atâţi atâția atunci au avea avem aveţi aveți avut aş aşadar aţi ași
așadar ați b ba bine bucur bună c ca care căreia cărora căruia cât câte câţi câți către ce cea ceea cei ceilalţi
ceilalți cel cele celor ceva chiar ci cinci cine cineva cât cu cum cumva curând curînd d da dacă dar datorită dată de
deci deja deoarece departe deşi deși din dinaintea dintr dintre doi doilea două drept după dă e ea ei el ele eram
este eu eşti ești face fata fi fie fiecare fii fim fiu fiţi fiți foarte fost fără g geaba graţie grație h halbă
i ia iar ieri îi îl îmi împotriva în înainte înaintea încât încît încotro între întrucât întrucît îţi îți j l la
le li lor lui lângă lîngă m ma mai mea mei mele mereu meu mi mie mine mult multă mulţi mulți mâine mîine mă n ne
nici nicăieri nimeni nimeri nimic nişte niște noastre noastră noi noroc nostru noştri noștri nou nouă nu numai o
opt or ori oricare orice oricine oricum oricând oricât oricînd oricît oriunde p pai parcă patra patru patrulea pe
pentru peste pic pina plus poate pot prea prima primul prin printr puţin puțin puţina puțina puţină puțină până
pînă r rog s sa sale sau se spate spre sub sunt suntem sunteţi sunteți sută sînt sîntem sînteţi sînteți t ta tale
tocmai toate toată toţi toți trei treia treilea tu tuturor tăi tău u ul ului un una unde undeva unei uneia unele
uneori unii unor unora unu unui unuia unul v va vi voastre voastră voi vostru vouă voştri voștri vreme vreo vreun
vă x z zece zero zi zice îi îl îmi împotriva în înainte înaintea încât încît încotro între întrucât întrucît îţi
îți ăla ălea ăsta ăstea ăştia ăștia şapte șapte şase șase şi și ştiu știu ţi ți ţie ție`);

export const STOP_WORDS: Readonly<Record<KeywordLanguage, readonly string[]>> = Object.freeze({
  en: ENGLISH,
  es: SPANISH,
  de: GERMAN,
  fr: FRENCH,
  ro: ROMANIAN,
});
