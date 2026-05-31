use std::time::Instant;
fn main() {
    let path = std::env::args().nth(1).expect("usage: dump_props <file>");
    let bytes = std::fs::read(&path).unwrap();
    let t = Instant::now();
    let props = pdm_sw_parser::parse_properties(&bytes);
    let ms = t.elapsed().as_millis();
    println!("{} ({} bytes) → {} properties in {} ms", path, bytes.len(), props.len(), ms);
    for p in &props {
        println!("    {:<28} = {}", p.name, p.value);
    }
}
