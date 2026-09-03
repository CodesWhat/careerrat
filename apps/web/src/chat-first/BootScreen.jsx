import careerratMark from "../assets/careerrat-icon.png";
import "./boot-screen.css";

export function BootScreen() {
  return (
    <div className="cf-boot-screen">
      <div className="cf-boot-screen__content">
        <img className="cf-boot-screen__mark" src={careerratMark} alt="" aria-hidden="true" />
        <p className="cf-boot-screen__status" role="status" aria-live="polite">
          Getting things ready.
        </p>
      </div>
    </div>
  );
}
