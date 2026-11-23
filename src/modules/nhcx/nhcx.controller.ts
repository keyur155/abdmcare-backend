import { asyncHandler } from "@common/middleware";
import { NhcxService } from "./nhcx.service";
import ResponseHandler from "@common/utils/response";
import { Request, Response, NextFunction } from 'express';
export class NhcxController {
    private NhcxService :NhcxService ;
    constructor(){
          this.NhcxService = new NhcxService();
    }

    registerHospital = asyncHandler(
        async (req: Request, res: Response, _next: NextFunction) =>{
            const { id } = req.params;
            const result = await this.NhcxService.registerHospital(id);
            ResponseHandler.success(res, result.message, result.data);
        }
    )

    
}


export default new NhcxController();